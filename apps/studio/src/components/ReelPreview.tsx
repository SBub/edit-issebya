"use client";

import {
  type Edit,
  FONT_PAIRS,
  FONT_ROLES,
  type FontPair,
  type FontPairId,
  type FontRole,
  type HeadTrack,
  ISSEBYA_PRESET,
  type Measurer,
  type OwnerAdd,
  type OwnerMove,
  type OwnerPhoto,
  type PlacedComponent,
  type Transcript,
  applyOwnerAdds,
  build,
  createMeasurer,
  effectiveMoves,
  headTrackSchema,
  applyOwnerMoves,
  nextOwnerVisualId,
  ownerAddPlacement,
  ownerAddSpan,
  ownerAddWord,
  ownerWrapOptions,
  parseEdit,
  photoPath,
  settleOwnerMove,
  transcriptSchema,
} from "@edit-issebya/edit";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { requestOwnerEdit } from "@/app/change-actions";
import { type PreviewSourcesResult, loadPreviewSources } from "@/app/preview-actions";
import { MoveLayer } from "@/components/MoveLayer";
import { type PickedPhoto, PicturePicker } from "@/components/PicturePicker";
import { PreviewPlayer, type PreviewPlayerHandle } from "@/components/PreviewPlayer";
import { type TimelineFrames, TracksTimeline } from "@/components/TracksTimeline";
import { isChromium } from "@/lib/browser";
import { editAssetUrl } from "@/lib/edit-assets";
import type { JobRow } from "@/lib/jobs";
import { type PageElements, dragPatch, pageElements, wrapPatch } from "@/lib/live-page";
import {
  type Drag,
  type OwnerAsk,
  type WrapOption,
  moveOfDrag,
  resolveAsk,
  showMoment,
  swapAsk,
  withMove,
} from "@/lib/owner-edit";
import { previewPage } from "@/lib/preview-page";
import { recordPreviewBuild } from "@/lib/preview-test-hooks";
import { type SoundHit, soundHits } from "@/lib/sound-schedule";
import { capture } from "@/lib/track";
import { type Timeline, timelineRows } from "@/lib/tracks-timeline";

// One built page: the version's own, or the move and resize editor's draft.
interface Page {
  html: string;
  hits: SoundHit[];
  // Every component with its box on screen, from the builder.
  components: PlacedComponent[];
}

interface Built {
  versionId: string;
  page: Page;
  // The version's edit and what it was built with: the editor applies the
  // owner's moves to the edit and builds the draft with the same builder.
  edit: Edit;
  context: { transcript: Transcript; headTrack: HeadTrack; measurer: Measurer };
  pageOf: (edit: Edit) => Page;
  // The large copy's URL of each library photo a page may show, by the path
  // the page names it at: the version's own (signed with the sources), and
  // each one the owner picks in the editor (the library's signed URL).
  photoUrls: Map<string, string>;
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
  "no-version": "The preview appears once the first version is saved",
  "no-previews": "This reel has no preview copies yet",
  "photo-missing": "A photo in this version was deleted from the library",
  "cutout-cleared": "This version's cut-out was cleared to save space; Export rebuilds it",
  unconfigured: "The preview is not available: storage is not configured",
  "signed-out": "Sign in again to see the preview",
  failed: "The preview could not be loaded",
};

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

const fonts = new Map<FontPairId, Promise<Record<FontRole, Uint8Array>>>();

// One font pair's files, fetched once per page load and pair.
function loadFonts(pair: FontPair): Promise<Record<FontRole, Uint8Array>> {
  let entry = fonts.get(pair.id);
  if (!entry) {
    entry = Promise.all(
      FONT_ROLES.map(async (role) => {
        const response = await fetchOk(editAssetUrl(pair[role].file));
        return [role, new Uint8Array(await response.arrayBuffer())] as const;
      }),
    )
      .then((files) => Object.fromEntries(files) as Record<FontRole, Uint8Array>)
      .catch((error: unknown) => {
        fonts.delete(pair.id);
        throw error;
      });
    fonts.set(pair.id, entry);
  }
  return entry;
}

// Signed sources, then the page built here by packages/edit's one builder
// (never stored), then the preview transform and the sounds the edit uses.
async function loadPreview(reelId: string, versionId: string): Promise<Outcome> {
  const sources = await loadPreviewSources(reelId, versionId);
  if (sources.status !== "ready") {
    return { forVersion: versionId, status: "message", message: MESSAGES[sources.status] };
  }
  const { urls } = sources;
  const [editJson, transcriptJson, headTrackJson, hb] = await Promise.all([
    fetchOk(urls.edit).then((r) => r.json() as Promise<unknown>),
    fetchOk(urls.transcript).then((r) => r.json() as Promise<unknown>),
    fetchOk(urls.headTrack).then((r) => r.json() as Promise<unknown>),
    import("harfbuzzjs"),
  ]);
  const transcript = transcriptSchema.parse(transcriptJson);
  const headTrack = headTrackSchema.parse(headTrackJson);
  const parsed = parseEdit(editJson, ISSEBYA_PRESET, transcript);
  if (!parsed.ok) throw new Error(`edit refused: ${parsed.reasons.join("; ")}`);
  const { edit } = parsed;
  // The version's own pair: its files are the ones the page loads and measures.
  const pair = FONT_PAIRS[edit.font_pair];
  const fontBytes = await loadFonts(pair);
  const measurer = createMeasurer(hb, pair, fontBytes);
  const photoUrls = new Map(urls.photos.map((photo) => [photo.path, photo.url]));
  // The one builder, then the preview transform: the version's page and every
  // draft of the editor are made the same way.
  const pageOf = (shown: Edit, record = false): Page => {
    const result = build(shown, transcript, headTrack, ISSEBYA_PRESET, measurer);
    if (record) recordPreviewBuild(result.html);
    const pageHits = soundHits(shown, transcript, ISSEBYA_PRESET);
    return {
      html: previewPage(
        result.html,
        result.assets,
        {
          footage: urls.footage,
          masks: urls.masks,
          photos: [...photoUrls].map(([path, url]) => ({ path, url })),
        },
        pageHits.map((hit) => hit.id),
      ),
      hits: pageHits,
      components: result.components,
    };
  };
  const page = pageOf(edit, true);
  const { hits } = page;
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
      page,
      edit,
      context: { transcript, headTrack, measurer },
      pageOf: (shown) => pageOf(shown),
      photoUrls,
      soundBytes,
      timeline: timelineRows(edit, transcript),
      frames:
        urls.frames && sources.framesLayout
          ? { url: urls.frames, layout: sources.framesLayout }
          : null,
    },
  };
}

// The move and resize editor's draft (app_docs/owner-edits.md): the version's
// edit with the owner's added cards and moves so far, and its page.
interface Draft {
  edit: Edit;
  moves: OwnerMove[];
  adds: OwnerAdd[];
  page: Page;
}

// What the picture picker is open for: a card's picture swapped, or a card
// added at the paused moment.
type Picking = { mode: "swap"; id: string } | { mode: "add" };

// One wrap width an edge handle can give, and the elements a page built with
// it draws.
type WrapPreview = WrapOption & { elements: PageElements };

type LiveJob = Pick<JobRow, "id" | "status">;

const SAVE_FAILED = "Your changes were not saved. Try again";

// One built version: the player and its tracks timeline (hidden while the
// preview is expanded), the playhead
// following the player's clock (set only from the player's callback) and the
// timeline's ruler seeking through the player's own seek. Keyed
// by version, so a new version mounts a new player, started from the
// hand-off (the previous version's position and play or pause state).
//
// Edit opens the editor over the paused preview: the owner selects a
// text component, drags it or its corner handle, and each drag builds the
// draft again with the one builder, so what shows is what Save will save. The
// player readies the draft's page behind the one on screen and swaps it in
// once it shows the same moment: the video never goes black.
// Save queues an `owner_edit` job; the worker saves a new version and the
// preview switches to it like to any new version. Cancel drops the draft.
function BuiltPreview({
  reelId,
  built,
  handoff,
  onHandoff,
  expanded,
  onExpandedChange,
  jobs,
  ownerEdit,
  editBlockedReason,
}: {
  reelId: string;
  built: Built;
  // Why editing is off (the reel is exporting), or null.
  editBlockedReason: string | null;
  // The editor's flag: off, neither its button nor the editor exists.
  ownerEdit: boolean;
  handoff: Handoff;
  onHandoff: (change: Partial<Handoff>) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  jobs: readonly LiveJob[];
}) {
  const router = useRouter();
  const [position, setPosition] = useState(handoff.position);
  const playerRef = useRef<PreviewPlayerHandle>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // The save: being sent, or the job it queued.
  const [sent, setSent] = useState<"sending" | { jobId: string } | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  // The library photos the owner picked in this editor, by id: the draft and
  // its settling read their size from here (the worker reads its own).
  const photosRef = useRef(new Map<string, OwnerPhoto>());
  const page = draft?.page ?? built.page;
  const sentJob = sent && sent !== "sending" ? jobs.find((job) => job.id === sent.jobId) : null;
  const saveFailed = sentJob?.status === "failed" || sentJob?.status === "cancelled";
  const saving = sent !== null && !saveFailed;
  // While the reel exports the editor is frozen: it cannot be opened, and an
  // open one keeps its draft but takes no drag and no Save until the export
  // ends or is cancelled.
  const frozen = saving || editBlockedReason !== null;
  // The lines an edge handle can give the component it is held on, each with
  // the elements a page built with them draws: read once per press.
  const wrapsRef = useRef<{
    html: string;
    component: PlacedComponent;
    options: WrapPreview[];
  } | null>(null);

  function openEditor() {
    playerRef.current?.pause();
    setEditing(true);
    setMessage("");
  }

  function closeEditor() {
    setPicking(null);
    setDraft(null);
    setEditing(false);
    setSelectedId(null);
    setMessage("");
    setSent(null);
  }

  // What the draft is built and settled with: the version's own context and
  // the photos picked so far.
  function editContext() {
    return { ...built.context, preset: ISSEBYA_PRESET, photos: photosRef.current };
  }

  // One frame of a drag: the page on screen shows the component where the
  // pointer has it, at once (app_docs/owner-edits.md, "Instant moves"). A move,
  // a corner resize or a card's turn restyles its elements; an edge handle shows the lines
  // the drop would give, read from pages built with each wrap width once per
  // press. Null when the drag is dropped with nothing to show.
  function dragFrame(component: PlacedComponent, drag: Drag | null) {
    const player = playerRef.current;
    if (!player) return;
    if (!drag) {
      wrapsRef.current = null;
      player.live(null);
      return;
    }
    if (drag.mode === "move" || drag.mode === "resize" || drag.mode === "rotate") {
      player.live(dragPatch(pageElements(page.html), component, drag));
      return;
    }
    const ask = moveOfDrag(component, drag);
    if (!ask || ask.kind === "box") return;
    const options = wrapPreviews(component);
    if (options.length === 0) return;
    const chosen = resolveAsk(ask, options);
    const option = options.find((entry) => entry.width === chosen.width) ?? options[0]!;
    player.live(
      wrapPatch(option.elements, component, chosen.x - component.x, chosen.y - component.y),
    );
  }

  // Every wrap width of a component at its size, each with the elements a
  // page built with it draws (the one builder's own lines).
  function wrapPreviews(component: PlacedComponent): WrapPreview[] {
    const known = wrapsRef.current;
    if (known && known.html === page.html && known.component === component) return known.options;
    const edit = draft?.edit ?? built.edit;
    const context = editContext();
    const at = { x: component.x, y: component.y, size: component.size ?? 0 };
    const options = (ownerWrapOptions(edit, component.id, at, context) ?? []).flatMap((option) => {
      const applied = applyOwnerMoves(
        edit,
        [{ id: component.id, ...at, width: option.width }],
        context,
      );
      if (!applied.ok) return [];
      const html = build(
        applied.edit,
        built.context.transcript,
        built.context.headTrack,
        ISSEBYA_PRESET,
        built.context.measurer,
      ).html;
      return [{ ...option, elements: pageElements(html) }];
    });
    wrapsRef.current = { html: page.html, component, options };
    return options;
  }

  // A finished drag: an edge handle's width or height turned into the lines
  // that give it (`ownerWrapOptions`), a move or a corner resize keeping the
  // wrap width an earlier edge drag set (scaled with the size, so its lines
  // stay), then made legal (inside the safe zone, a size the text may take),
  // applied to the draft, and the draft's page built.
  function move(ask: OwnerAsk) {
    const edit = draft?.edit ?? built.edit;
    const context = editContext();
    let asked: OwnerMove;
    if (ask.kind === "box") {
      // A VISUAL: its box, its height following its picture. A card whose
      // picture was swapped keeps its photo through later drags.
      const earlier = draft?.moves.find((entry) => entry.id === ask.id);
      asked =
        ask.photo_id === undefined && earlier?.kind === "box" && earlier.photo_id !== undefined
          ? { ...ask, photo_id: earlier.photo_id }
          : ask;
    } else if (ask.width !== undefined || ask.height !== undefined) {
      const options = ownerWrapOptions(edit, ask.id, ask, context);
      if (!options) {
        playerRef.current?.live(null);
        setMessage("This text keeps its lines");
        return;
      }
      asked = resolveAsk(ask, options);
    } else {
      const earlier = draft?.moves.find((entry) => entry.id === ask.id);
      asked =
        earlier === undefined || earlier.kind === "box" || earlier.width === undefined
          ? { id: ask.id, x: ask.x, y: ask.y, size: ask.size }
          : {
              id: ask.id,
              x: ask.x,
              y: ask.y,
              size: ask.size,
              width: (earlier.width * ask.size) / earlier.size,
            };
    }
    const settled = settleOwnerMove(edit, asked, context);
    if (!settled.ok) {
      playerRef.current?.live(null);
      setMessage("This text does not fit there");
      return;
    }
    setMessage("");
    setSent(null);
    const page = built.pageOf(settled.edit);
    // The same page again (a text put back where it was): nothing new to show,
    // so the drag's patch goes.
    if (page.html === (draft?.page ?? built.page).html) playerRef.current?.live(null);
    setDraft({
      edit: settled.edit,
      // Only what differs from the version: a text put back is no move.
      moves: effectiveMoves(
        withMove(draft?.moves ?? [], settled.move),
        built.page.components,
        page.components,
      ),
      adds: draft?.adds ?? [],
      page,
    });
  }

  // A library photo picked: its size kept for the draft and its large copy's
  // URL for the page.
  function remember(photo: PickedPhoto) {
    photosRef.current.set(photo.id, {
      id: photo.id,
      width: photo.width,
      height: photo.height,
      description: photo.description,
      tags: photo.tags,
    });
    built.photoUrls.set(photoPath(photo.id), photo.largeUrl);
  }

  // The selected card's picture swapped for a library photo: the card keeps
  // its place, rescaled to the photo's aspect ratio, settled like a move.
  function swapPicture(id: string, photo: PickedPhoto) {
    const component = page.components.find((entry) => entry.id === id);
    if (!component) return;
    remember(photo);
    move(swapAsk(component, photo));
  }

  // Where a card added now would start: the word under the playhead, and its
  // span; null over hidden footage or with no room left in the reel.
  function addSpot() {
    const edit = draft?.edit ?? built.edit;
    const word = ownerAddWord(built.context.transcript, position);
    const span = word && ownerAddSpan(edit, built.context.transcript, word.id);
    return word && span ? { word, span } : null;
  }

  // A card added at the paused moment showing a library photo: on the word
  // under the playhead for a fixed time, placed in a corner by the engine's
  // own placement, settled like a move, drawn on top of the cards there.
  function addPicture(photo: PickedPhoto) {
    const spot = addSpot();
    if (!spot) {
      setMessage("No picture can show here");
      return;
    }
    remember(photo);
    const edit = draft?.edit ?? built.edit;
    const context = editContext();
    const id = nextOwnerVisualId(edit);
    const at = ownerAddPlacement(edit, photo, spot.span, context);
    const add: OwnerAdd = { id, photo_id: photo.id, word: spot.word.id, ...at };
    const added = applyOwnerAdds(edit, [add], context);
    if (!added.ok) {
      setMessage("No picture can show here");
      return;
    }
    const settled = settleOwnerMove(added.edit, { id, kind: "box", ...at }, context);
    if (!settled.ok || settled.move.kind !== "box") {
      setMessage("No picture can show here");
      return;
    }
    const { x, y, width } = settled.move;
    const placed = applyOwnerAdds(edit, [{ ...add, x, y, width }], context);
    if (!placed.ok) return;
    setMessage("");
    setSent(null);
    setDraft({
      edit: placed.edit,
      moves: draft?.moves ?? [],
      adds: [...(draft?.adds ?? []), { ...add, x, y, width }],
      page: built.pageOf(placed.edit),
    });
    setSelectedId(id);
  }

  async function save() {
    if (!draft || draft.moves.length + draft.adds.length === 0) return;
    setSent("sending");
    setMessage("");
    try {
      const result = await requestOwnerEdit({
        reelId,
        versionId: built.versionId,
        moves: draft.moves,
        ...(draft.adds.length > 0 ? { adds: draft.adds } : {}),
      });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") {
        setSent({ jobId: result.jobId });
        setSelectedId(null);
        return;
      }
      setSent(null);
      setMessage(result.status === "failed" ? SAVE_FAILED : result.reason);
    } catch {
      setSent(null);
      setMessage(SAVE_FAILED);
    }
  }

  return (
    <>
      <PreviewPlayer
        ref={playerRef}
        html={page.html}
        versionId={built.versionId}
        hits={page.hits}
        soundBytes={built.soundBytes}
        startAt={handoff.position}
        autoPlay={handoff.intent === "playing"}
        onPosition={(seconds) => {
          setPosition(seconds);
          onHandoff({ position: seconds });
        }}
        onIntent={(intent) => onHandoff({ intent })}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        playDisabled={editing}
        controls={
          // Desktop only for now: the editor is built for a mouse.
          ownerEdit && (
            <button
              type="button"
              data-testid="edit-toggle"
              aria-pressed={editing}
              title={editBlockedReason ?? "Move or resize a text on screen"}
              onClick={editing ? closeEditor : openEditor}
              disabled={frozen}
              className="hidden h-8 flex-none items-center border border-line px-2.5 text-xs hover:bg-raised disabled:opacity-50 aria-pressed:bg-raised aria-pressed:font-semibold lg:flex"
            >
              Edit
            </button>
          )
        }
        overlay={
          ownerEdit &&
          editing && (
            <MoveLayer
              components={page.components}
              position={position}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPick={(component) => {
                setSelectedId(component.id);
                playerRef.current?.seek(showMoment(component));
              }}
              onMove={(ask) => {
                wrapsRef.current = null;
                move(ask);
              }}
              onDragFrame={dragFrame}
              onChangePicture={(component) => setPicking({ mode: "swap", id: component.id })}
              onAddPicture={() => setPicking({ mode: "add" })}
              canAdd={addSpot() !== null}
              changed={(draft?.moves.length ?? 0) + (draft?.adds.length ?? 0) > 0}
              saving={frozen}
              frozenReason={saving ? null : editBlockedReason}
              message={
                saveFailed
                  ? SAVE_FAILED
                  : saving
                    ? "Saving your changes"
                    : (editBlockedReason ?? message)
              }
              onSave={() => void save()}
              onCancel={closeEditor}
            />
          )
        }
      />
      {picking && (
        <PicturePicker
          title={picking.mode === "swap" ? "Change picture" : "Add a picture here"}
          onClose={() => setPicking(null)}
          onPick={(photo) => {
            if (picking.mode === "swap") swapPicture(picking.id, photo);
            else addPicture(photo);
          }}
        />
      )}
      {!expanded && (
        <TracksTimeline
          timeline={built.timeline}
          position={position}
          frames={built.frames}
          onSeek={(seconds) => playerRef.current?.seek(seconds)}
        />
      )}
    </>
  );
}

function subscribeNever(): () => void {
  return () => {};
}

// The live preview of the reel's current version with its tracks timeline. It
// loads when the current version changes (LiveReel follows the reel through
// Realtime): no reload, no polling. A load overtaken by a newer version is dropped. While the next
// version loads, the previous one keeps playing; the next one then takes over
// at the same time, playing or paused as it was.
export function ReelPreview({
  reelId,
  versionId,
  jobs = [],
  ownerEdit = false,
  editBlockedReason = null,
}: {
  reelId: string;
  versionId: string | null;
  // Why editing this reel is off (it is exporting), or null: the editor
  // cannot be opened, and an open one is frozen with this line.
  editBlockedReason?: string | null;
  // The reel's jobs: the editor follows the job its Save queued.
  jobs?: readonly LiveJob[];
  // Whether the owner's editor is on (the `studio-owner-edit` flag).
  ownerEdit?: boolean;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const opened = useRef(false);
  // The preview filling the edit area, the tracks timeline hidden: collapsed
  // on every open, never saved, kept across a version switch.
  const [expanded, setExpanded] = useState(false);
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
    </div>
  );

  return (
    <section aria-labelledby="preview-heading" className="flex min-h-0 flex-1 flex-col gap-2">
      <h2 id="preview-heading" className="sr-only">
        Preview
      </h2>
      {!chromium && <p className="text-sm text-muted">The preview is built for Chrome</p>}
      {!versionId ? (
        note(MESSAGES["no-version"])
      ) : built ? (
        <BuiltPreview
          key={built.versionId}
          reelId={reelId}
          built={built}
          jobs={jobs}
          ownerEdit={ownerEdit}
          editBlockedReason={editBlockedReason}
          handoff={handoff}
          onHandoff={(change) => {
            handoffRef.current = { ...handoffRef.current, ...change };
          }}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
      ) : current?.status === "message" ? (
        note(current.message)
      ) : (
        note("Loading the preview", true)
      )}
    </section>
  );
}
