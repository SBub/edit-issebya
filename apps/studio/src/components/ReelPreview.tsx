"use client";

import {
  FONT_KEYS,
  type FontKey,
  ISSEBYA_PRESET,
  build,
  createMeasurer,
  headTrackSchema,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type PreviewSourcesResult, loadPreviewSources } from "@/app/preview-actions";
import { PreviewPlayer } from "@/components/PreviewPlayer";
import { type TimelineFrames, TracksTimeline } from "@/components/TracksTimeline";
import { isChromium } from "@/lib/browser";
import { editAssetUrl } from "@/lib/edit-assets";
import { previewPage } from "@/lib/preview-page";
import { recordPreviewBuild } from "@/lib/preview-test-hooks";
import { type SoundHit, soundHits } from "@/lib/sound-schedule";
import { capture } from "@/lib/track";
import { type Timeline, timelineRows } from "@/lib/tracks-timeline";

interface Built {
  versionId: string;
  html: string;
  hits: SoundHit[];
  soundBytes: Record<string, ArrayBuffer>;
  // The same parsed edit's rows on the reel's clock (no second fetch, no
  // second builder).
  timeline: Timeline;
  frames: TimelineFrames | null;
}

// Where the shown player was and whether it was playing: the next version
// continues from there.
interface Handoff {
  position: number;
  intent: "paused" | "playing";
}

const FIRST_OPEN: Handoff = { position: 0, intent: "paused" };

// Each outcome remembers the version it was loaded for, so a newer selection
// keeps the previous preview until its own outcome arrives. A built outcome
// carries the hand-off read the moment it arrived.
type Outcome = { forVersion: string } & (
  { status: "built"; built: Built; handoff?: Handoff } | { status: "message"; message: string }
);

const MESSAGES: Record<Exclude<PreviewSourcesResult["status"], "ready">, string> = {
  "no-version": "The preview appears once the first version is saved.",
  "no-previews": "This reel has no preview copies yet.",
  "photo-missing": "A photo in this version was deleted from the library.",
  "cutout-cleared": "This version's cut-out was cleared to save space; Export rebuilds it.",
  unconfigured: "The preview is not available: storage is not configured.",
  "signed-out": "Sign in again to see the preview.",
  failed: "The preview could not be loaded.",
};

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

let fonts: Promise<Record<FontKey, Uint8Array>> | undefined;

// The preset's fonts, fetched once per page load.
function loadFonts(): Promise<Record<FontKey, Uint8Array>> {
  fonts ??= Promise.all(
    FONT_KEYS.map(async (key) => {
      const response = await fetchOk(editAssetUrl(ISSEBYA_PRESET.fonts[key].file));
      return [key, new Uint8Array(await response.arrayBuffer())] as const;
    }),
  )
    .then((entries) => Object.fromEntries(entries) as Record<FontKey, Uint8Array>)
    .catch((error: unknown) => {
      fonts = undefined;
      throw error;
    });
  return fonts;
}

// Signed sources, then the page built here by packages/edit's one builder
// (never stored), then the preview transform and the sounds the edit uses.
async function loadPreview(reelId: string, versionId: string): Promise<Outcome> {
  const sources = await loadPreviewSources(reelId, versionId);
  if (sources.status !== "ready") {
    return { forVersion: versionId, status: "message", message: MESSAGES[sources.status] };
  }
  const { urls } = sources;
  const [editJson, transcriptJson, headTrackJson, fontBytes, hb] = await Promise.all([
    fetchOk(urls.edit).then((r) => r.json() as Promise<unknown>),
    fetchOk(urls.transcript).then((r) => r.json() as Promise<unknown>),
    fetchOk(urls.headTrack).then((r) => r.json() as Promise<unknown>),
    loadFonts(),
    import("harfbuzzjs"),
  ]);
  const transcript = transcriptSchema.parse(transcriptJson);
  const headTrack = headTrackSchema.parse(headTrackJson);
  const parsed = parseEdit(editJson, ISSEBYA_PRESET, transcript);
  if (!parsed.ok) throw new Error(`edit refused: ${parsed.reasons.join("; ")}`);
  const { edit } = parsed;
  const result = build(edit, transcript, headTrack, ISSEBYA_PRESET, createMeasurer(hb, fontBytes));
  recordPreviewBuild(result.html);
  const hits = soundHits(edit, transcript, ISSEBYA_PRESET);
  const html = previewPage(
    result.html,
    result.assets,
    { footage: urls.footage, masks: urls.masks, photos: urls.photos },
    hits.map((hit) => hit.id),
  );
  const files = [...new Set(hits.map((hit) => hit.file))];
  const soundBytes = Object.fromEntries(
    await Promise.all(
      files.map(
        async (file) => [file, await (await fetchOk(editAssetUrl(file))).arrayBuffer()] as const,
      ),
    ),
  );
  return {
    forVersion: versionId,
    status: "built",
    built: {
      versionId: sources.versionId,
      html,
      hits,
      soundBytes,
      timeline: timelineRows(edit, transcript),
      frames:
        urls.frames && sources.framesLayout
          ? { url: urls.frames, layout: sources.framesLayout }
          : null,
    },
  };
}

// One built version: the player and its tracks timeline, the playhead
// following the player's clock (set only from the player's callback). Keyed
// by version, so a new version mounts a new player, started from the
// hand-off (the previous version's position and play or pause state).
function BuiltPreview({
  built,
  controls,
  handoff,
  onHandoff,
}: {
  built: Built;
  controls: ReactNode;
  handoff: Handoff;
  onHandoff: (change: Partial<Handoff>) => void;
}) {
  const [position, setPosition] = useState(handoff.position);
  return (
    <>
      <PreviewPlayer
        html={built.html}
        versionId={built.versionId}
        hits={built.hits}
        soundBytes={built.soundBytes}
        startAt={handoff.position}
        autoPlay={handoff.intent === "playing"}
        onPosition={(seconds) => {
          setPosition(seconds);
          onHandoff({ position: seconds });
        }}
        onIntent={(intent) => onHandoff({ intent })}
        controls={controls}
      />
      <TracksTimeline timeline={built.timeline} position={position} frames={built.frames} />
    </>
  );
}

function subscribeNever(): () => void {
  return () => {};
}

// The live preview of the shown version (the current one unless Undo or Redo
// picked another) with its tracks timeline. It loads when the shown version
// changes (LiveReel follows the reel through Realtime): no reload, no
// polling. A load overtaken by a newer version is dropped. While the next
// version loads, the previous one keeps playing; the next one then takes over
// at the same time, playing or paused as it was.
export function ReelPreview({
  reelId,
  versionId,
  controls,
}: {
  reelId: string;
  versionId: string | null;
  // Undo and Redo, shown in the player's control row.
  controls: ReactNode;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const opened = useRef(false);
  // The mounted player's position and intent; the first open starts at 0, paused.
  const handoffRef = useRef<Handoff>(FIRST_OPEN);
  // Read after hydration; the server renders as Chromium, so no note flashes.
  const chromium = useSyncExternalStore(
    subscribeNever,
    () => isChromium(navigator),
    () => true,
  );

  useEffect(() => {
    if (!versionId) return;
    let stale = false;
    loadPreview(reelId, versionId)
      .then((next) => {
        if (stale) return;
        setOutcome(
          next.status === "built" ? { ...next, handoff: { ...handoffRef.current } } : next,
        );
      })
      .catch((error: unknown) => {
        console.error("studio: preview not built:", (error as Error).message);
        if (!stale) {
          setOutcome({ forVersion: versionId, status: "message", message: MESSAGES.failed });
        }
      });
    return () => {
      stale = true;
    };
  }, [reelId, versionId]);

  const current = outcome && outcome.forVersion === versionId ? outcome : null;
  // The previous version's preview stays until the shown version's own
  // outcome arrives (a message for it replaces it).
  const shown = current ?? (outcome?.status === "built" ? outcome : null);
  const built = shown?.status === "built" ? shown.built : null;
  const handoff = (shown?.status === "built" && shown.handoff) || FIRST_OPEN;

  // Once per preview open, the first time a page reaches the player.
  useEffect(() => {
    if (!built || opened.current) return;
    opened.current = true;
    capture("studio_preview_opened", { reel_id: reelId });
  }, [built, reelId]);

  const note = (text: string, status = false) => (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
      <p role={status ? "status" : undefined} className="text-sm text-muted">
        {text}
      </p>
      {versionId && <div className="flex items-center gap-2">{controls}</div>}
    </div>
  );

  return (
    <section aria-labelledby="preview-heading" className="flex min-h-0 flex-1 flex-col gap-2">
      <h2 id="preview-heading" className="sr-only">
        Preview
      </h2>
      {!chromium && <p className="text-sm text-muted">The preview is built for Chrome.</p>}
      {!versionId ? (
        note(MESSAGES["no-version"])
      ) : built ? (
        <BuiltPreview
          key={built.versionId}
          built={built}
          controls={controls}
          handoff={handoff}
          onHandoff={(change) => {
            handoffRef.current = { ...handoffRef.current, ...change };
          }}
        />
      ) : current?.status === "message" ? (
        note(current.message)
      ) : (
        note("Loading the preview", true)
      )}
    </section>
  );
}
