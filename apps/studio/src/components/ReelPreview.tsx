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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type PreviewSourcesResult, loadPreviewSources } from "@/app/preview-actions";
import { PreviewPlayer } from "@/components/PreviewPlayer";
import { isChromium } from "@/lib/browser";
import { editAssetUrl } from "@/lib/edit-assets";
import { previewPage } from "@/lib/preview-page";
import { recordPreviewBuild } from "@/lib/preview-test-hooks";
import { type SoundHit, soundHits } from "@/lib/sound-schedule";
import { capture } from "@/lib/track";

interface Built {
  versionId: string;
  html: string;
  hits: SoundHit[];
  soundBytes: Record<string, ArrayBuffer>;
}

type Outcome = { status: "built"; built: Built } | { status: "message"; message: string };

const MESSAGES: Record<Exclude<PreviewSourcesResult["status"], "ready">, string> = {
  "no-version": "The preview appears once the first version is saved.",
  "no-previews": "This reel has no preview copies yet.",
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
async function loadPreview(reelId: string): Promise<Outcome> {
  const sources = await loadPreviewSources(reelId);
  if (sources.status !== "ready") return { status: "message", message: MESSAGES[sources.status] };
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
    { footage: urls.footage, cutout: urls.cutout },
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
  return { status: "built", built: { versionId: sources.versionId, html, hits, soundBytes } };
}

function subscribeNever(): () => void {
  return () => {};
}

// The live preview of the reel's current version. It loads when the version
// changes (LiveReel follows the reel through Realtime): no reload, no
// polling. A load overtaken by a newer version is dropped.
export function ReelPreview({
  reelId,
  currentVersionId,
}: {
  reelId: string;
  currentVersionId: string | null;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const opened = useRef(false);
  // Read after hydration; the server renders as Chromium, so no note flashes.
  const chromium = useSyncExternalStore(
    subscribeNever,
    () => isChromium(navigator),
    () => true,
  );

  useEffect(() => {
    if (!currentVersionId) return;
    let stale = false;
    loadPreview(reelId)
      .then((next) => {
        if (!stale) setOutcome(next);
      })
      .catch((error: unknown) => {
        console.error("studio: preview not built:", (error as Error).message);
        if (!stale) setOutcome({ status: "message", message: MESSAGES.failed });
      });
    return () => {
      stale = true;
    };
  }, [reelId, currentVersionId]);

  const built = outcome?.status === "built" ? outcome.built : null;

  // Once per preview open, the first time a page reaches the player.
  useEffect(() => {
    if (!built || opened.current) return;
    opened.current = true;
    capture("studio_preview_opened", { reel_id: reelId });
  }, [built, reelId]);

  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-2">
      <h2 id="preview-heading" className="text-lg font-semibold">
        Preview
      </h2>
      {!chromium && <p className="text-sm text-stone-600">The preview is built for Chrome.</p>}
      {!currentVersionId ? (
        <p className="text-sm text-stone-600">{MESSAGES["no-version"]}</p>
      ) : built ? (
        <PreviewPlayer
          key={built.versionId}
          html={built.html}
          versionId={built.versionId}
          hits={built.hits}
          soundBytes={built.soundBytes}
        />
      ) : outcome?.status === "message" ? (
        <p className="text-sm text-stone-600">{outcome.message}</p>
      ) : (
        <p role="status" className="text-sm text-stone-600">
          Loading the preview
        </p>
      )}
    </section>
  );
}
