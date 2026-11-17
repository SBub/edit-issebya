import { build } from "./build.ts";
import type { PlacedComponent } from "./components.ts";
import { type Obstacle, placeElement } from "./engine-place.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import { type HeadTrack, facesOver } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { MIN_BOX_PX, type OwnerPhoto, type OwnerPhotos, isPhotoId } from "./owner-edit.ts";
import { withPhotoInputs } from "./photos.ts";
import { type Preset, SHOWN_FLOOR_SECONDS } from "./preset.ts";
import type { Anchor, BehindVisualItem, Edit } from "./schema.ts";
import { anchorAt, resolveSpans, resolveTimeline } from "./timeline.ts";
import type { Transcript, Word } from "./transcript.ts";
import { VARIANTS } from "./variants.ts";

// THE OWNER'S ADDED CARDS (app_docs/owner-edits.md): in the Move editor the
// owner adds a VISUAL showing one of their library photos at the paused
// moment. It starts on the word under the playhead and lasts a fixed time,
// cut short by the reel's end or a hidden stretch of footage; the studio
// places it in a corner with the engine's own placement and settles it like a
// move. The worker trusts only the word, the photo id and the box: the photo's
// size comes from the owner's library, the times from the transcript.

// How long an added card shows, in seconds (owner decision, 2026-11-17).
export const OWNER_ADD_SECONDS = 1.5;

// How many cards one save may add.
const OWNER_ADDS_MAX = 20;

// An added card's id: `owner-visual-N`.
const ADD_ID = /^owner-visual-([1-9][0-9]{0,2})$/;

// The longest a card's description is stored (the schema's limit).
const DESCRIPTION_MAX = 120;

// One card the owner adds: its id, the library photo it shows, the word it
// starts on, and its box's top left corner and width in frame pixels (its
// height follows the photo).
export interface OwnerAdd {
  id: string;
  photo_id: string;
  word: string;
  x: number;
  y: number;
  width: number;
}

interface Context {
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  measurer: Measurer;
  photos?: OwnerPhotos;
}

// A job's added cards as they arrive (untrusted JSON): absent is none; else
// a list of at most `OWNER_ADDS_MAX`, no id twice, each an `owner-visual-N`
// id, a photo id, a word id and finite numbers, the width positive. Null when
// it is anything else.
export function parseOwnerAdds(json: unknown): OwnerAdd[] | null {
  if (json === undefined) return [];
  if (!Array.isArray(json) || json.length > OWNER_ADDS_MAX) return null;
  const adds: OwnerAdd[] = [];
  const seen = new Set<string>();
  for (const entry of json as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, photo_id: photoId, word, x, y, width } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !ADD_ID.test(id) || seen.has(id)) return null;
    if (!isPhotoId(photoId)) return null;
    if (typeof word !== "string" || word.length === 0 || word.length > 64) return null;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || width <= 0) {
      return null;
    }
    seen.add(id);
    adds.push({ id, photo_id: photoId, word, x, y, width });
  }
  return adds;
}

// The id of the next card the owner adds: one past the highest
// `owner-visual-N` of the edit.
export function nextOwnerVisualId(edit: Pick<Edit, "tracks">): string {
  let highest = 0;
  for (const item of edit.tracks.behind ?? []) {
    const match = ADD_ID.exec(item.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `owner-visual-${highest + 1}`;
}

// The word under the playhead: the one spoken at `seconds`, else the next one
// to be spoken, else the last. Null for a reel with no words.
export function ownerAddWord(transcript: Transcript, seconds: number): Word | null {
  const { words } = transcript;
  return (
    words.find((word) => word.start <= seconds && seconds < word.end) ??
    words.find((word) => word.start >= seconds) ??
    words.at(-1) ??
    null
  );
}

// When a card added on a word shows: from the word's start for
// `OWNER_ADD_SECONDS`, cut short by the reel's end or the next hidden stretch
// of footage. Null when the word is unknown, starts inside a hidden stretch,
// or leaves less than the shown floor.
export function ownerAddSpan(
  edit: Edit,
  transcript: Transcript,
  wordId: string,
): { start: number; end: number } | null {
  const word = transcript.words.find((entry) => entry.id === wordId);
  if (!word) return null;
  const start = Math.round(word.start * 1000) / 1000;
  const hidden = edit.tracks.footage.flatMap((clip) => resolveSpans(clip.hidden, edit, transcript));
  if (hidden.some((span) => span.start <= start + 1e-6 && start < span.end - 1e-6)) return null;
  const nextHidden = Math.min(
    ...hidden.filter((span) => span.start > start + 1e-6).map((span) => span.start),
  );
  const end =
    Math.round(Math.min(start + OWNER_ADD_SECONDS, edit.duration, nextHidden) * 1000) / 1000;
  return end - start >= SHOWN_FLOOR_SECONDS - 1e-6 ? { start, end } : null;
}

// A card's description from the photo's: at most the stored length, cut at
// a word; none for a photo with no description.
function cardDescription(text: string | null | undefined): string | undefined {
  const plain = (text ?? "").trim().replace(/\s+/g, " ");
  if (plain.length === 0) return undefined;
  if (plain.length <= DESCRIPTION_MAX) return plain;
  const cut = plain.slice(0, DESCRIPTION_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : plain.slice(0, DESCRIPTION_MAX)).trim();
}

// The end anchor of an added card: the reel's end, or a word's end with an
// offset (`anchorAt`).
function endAnchor(end: number, edit: Edit, transcript: Transcript): Anchor {
  if (Math.abs(end - edit.duration) < 1e-6) return { reel: "end" };
  return anchorAt(end, transcript.words);
}

// The edit with the owner's added cards, each a VISUAL at the end of the
// `behind` track (drawn on top of every card before it) showing its library
// photo at its box (its height the photo's aspect at its width), timed by
// `ownerAddSpan`, its description the photo's. Each gets a click as it comes
// in, unless another sound starts within the click's gap of it (`sound-gap`).
// `inputs.photos` names the photos shown. Refused with reasons: an id already
// in the edit, a photo that is not one of `photos`, a word where no card can
// show, a width outside 100 px to the frame's width.
export function applyOwnerAdds(
  edit: Edit,
  adds: readonly OwnerAdd[],
  { transcript, preset, photos }: Pick<Context, "transcript" | "preset" | "photos">,
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  if (adds.length === 0) return { ok: true, edit };
  const reasons: string[] = [];
  const ids = new Set(
    [
      ...edit.tracks.footage,
      ...edit.tracks.captions,
      ...edit.tracks.overlays,
      ...edit.tracks.transitions,
      ...edit.tracks.sounds,
      ...(edit.tracks.behind ?? []),
    ].map((item) => item.id),
  );
  const behind = [...(edit.tracks.behind ?? [])];
  const sounds = [...edit.tracks.sounds];
  const resolved = resolveTimeline(edit, transcript);
  const soundStarts = sounds.map((sound) => resolved.get(sound.id)?.start ?? -Infinity);
  const { minGapSeconds } = preset.sounds.click;
  for (const add of adds) {
    if (ids.has(add.id) || ids.has(`click-${add.id}`)) {
      reasons.push(`${add.id}: already in this version`);
      continue;
    }
    const photo = photos?.get(add.photo_id);
    if (!photo) {
      reasons.push(`${add.id}: photo ${add.photo_id} is not a ready photo in your library`);
      continue;
    }
    const span = ownerAddSpan(edit, transcript, add.word);
    if (!span) {
      reasons.push(`${add.id}: no card can show from word ${add.word}`);
      continue;
    }
    if (add.width < MIN_BOX_PX - 1e-6 || add.width > preset.frame.width + 1e-6) {
      reasons.push(
        `${add.id}: width ${add.width} is outside ${MIN_BOX_PX} to ${preset.frame.width} px`,
      );
      continue;
    }
    ids.add(add.id);
    const width = Math.round(add.width);
    const description = cardDescription(photo.description);
    const item: BehindVisualItem = {
      id: add.id,
      kind: "visual",
      start: { word: add.word },
      end: endAnchor(span.end, edit, transcript),
      ...(description ? { description } : {}),
      photo: { id: photo.id, width: photo.width, height: photo.height },
      box: {
        x: Math.round(add.x),
        y: Math.round(add.y),
        width,
        height: Math.max(1, Math.round((width * photo.height) / photo.width)),
      },
    };
    behind.push(item);
    // The click as it comes in, unless another sound is within its gap.
    if (soundStarts.every((at) => Math.abs(at - span.start) >= minGapSeconds - 1e-6)) {
      sounds.push({ id: `click-${add.id}`, sound: "click", start: item.start, end: item.end });
      soundStarts.push(span.start);
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    edit: withPhotoInputs({ ...edit, tracks: { ...edit.tracks, sounds, behind } }),
  };
}

// What a placed component is to the engine's placer when a card is added
// over it: a caption blocks everything, a big word and another card block a
// card (so an added card keeps off the cards already there), any other text
// does not (a card may sit under a text, decision 9).
function obstacleOf(component: PlacedComponent): Obstacle {
  const box = {
    left: component.x,
    right: component.x + component.width,
    top: component.y,
    bottom: component.y + component.height,
  };
  const kind =
    component.component === "CAPTION"
      ? "caption"
      : component.component === "VISUAL" || component.component === "BIGWORD"
        ? "behind"
        : "text";
  return { id: component.id, kind, box };
}

// Where a card added over `span` showing `photo` goes: the engine's own
// placement of a card (`visual/card`: a corner, else beside the face, at the
// photo's aspect), with what is on screen then as obstacles; the cards already
// there left out of the way when nothing else fits; the safe zone's top left
// corner at the card's full width when even that finds no spot. The caller
// settles it like a move (`settleOwnerMove`).
export function ownerAddPlacement(
  edit: Edit,
  photo: Pick<OwnerPhoto, "width" | "height">,
  span: { start: number; end: number },
  { transcript, headTrack, preset, measurer }: Context,
): { x: number; y: number; width: number } {
  const variant = VARIANTS["visual/card"];
  const components = build(edit, transcript, headTrack, preset, measurer, {
    layer: "front",
  }).components.filter(
    (component) => component.start < span.end - 1e-6 && span.start < component.end - 1e-6,
  );
  const faces = facesOver(headTrack, span.start - 0.25, span.end + 0.25);
  const element = {
    type: "box" as const,
    id: "owner-card",
    variant,
    aspect: photo.width / photo.height,
    start: span.start,
    end: span.end,
  };
  const attempt = (obstacles: Obstacle[]) =>
    placeElement(element, { faces, obstacles, safe: SAFE_ZONE }, measurer).placed;
  const placed =
    attempt(components.map(obstacleOf)) ??
    attempt(components.filter((component) => component.component !== "VISUAL").map(obstacleOf));
  if (placed) {
    const box = placed.box;
    return { x: box.left, y: box.top, width: box.right - box.left };
  }
  const safe = SAFE_ZONE.box;
  const width = Math.max(MIN_BOX_PX, Math.round((safe.right - safe.left) / 3));
  return { x: safe.left, y: safe.top, width };
}
