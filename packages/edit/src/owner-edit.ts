import { bigWordNeedsCutout, paddedSpan, placedBigWord } from "./behind.ts";
import { build } from "./build.ts";
import type { PlacedComponent } from "./components.ts";
import type { EngineComponent, EngineNote } from "./engine-note.ts";
import { MIN_SIZE_PX } from "./engine-place.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import { type Box, type HeadTrack, boundingBox, facesOver } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import type { Preset } from "./preset.ts";
import type { Edit, TransitionLevel } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";
import { LEVEL_ROLES, levelBoxes } from "./transitions.ts";

// THE OWNER'S MOVES (app_docs/owner-edits.md): in the studio the owner moves
// and resizes a text component on screen, and Save makes a new version from
// them. A component has one box for its whole time on screen, so a move moves
// it for all of it. Only its place and its text size change: never its words,
// its time, its lines or what its variant draws inside the box.

// The components the owner may move and resize: every text pick. Captions and
// VISUALs are not (visuals get their own step later).
export const MOVABLE_COMPONENTS: readonly EngineComponent[] = [
  "ACCENT",
  "QUESTION",
  "BIGWORD",
  "LIST",
  "HOOK",
];

export function isMovable(component: Pick<PlacedComponent, "component">): boolean {
  return MOVABLE_COMPONENTS.includes(component.component);
}

// One move: the component's id, the top left corner of its box in frame pixels
// and its text size (a LIST's is its key phrase's; its other levels keep their
// ratio to it). A move that only moves keeps the size; one that only resizes
// keeps the corner.
export interface OwnerMove {
  id: string;
  x: number;
  y: number;
  size: number;
}

// The largest text size of the format (`schema.ts`): an overlay or a level.
const MAX_TEXT_SIZE = 400;

// How many moves one save may carry: more than any reel has components.
export const OWNER_MOVES_MAX = 200;

const SLACK = 1e-6;

interface Context {
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  measurer: Measurer;
}

// A job's moves as they arrive (untrusted JSON): a list of at most
// `OWNER_MOVES_MAX` moves, each an id, finite coordinates and a whole size, no
// id twice. Null when it is anything else.
export function parseOwnerMoves(json: unknown): OwnerMove[] | null {
  if (!Array.isArray(json) || json.length === 0 || json.length > OWNER_MOVES_MAX) return null;
  const moves: OwnerMove[] = [];
  const seen = new Set<string>();
  for (const entry of json as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, x, y, size } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 64 || seen.has(id)) return null;
    if (typeof x !== "number" || typeof y !== "number" || typeof size !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(size)) return null;
    seen.add(id);
    moves.push({ id, x, y, size });
  }
  return moves;
}

// The sizes a component may take: never under the placer's 30 px (a LIST: its
// smallest level never under it) nor above the format's largest text (a big
// word: the frame's height). The safe zone bounds it further (`settleOwnerMove`).
export function ownerSizeRange(edit: Edit, id: string, preset: Preset): [number, number] | null {
  const overlay = edit.tracks.overlays.find((item) => item.id === id);
  if (overlay) return [MIN_SIZE_PX, MAX_TEXT_SIZE];
  const word = (edit.tracks.behind ?? []).find((item) => item.id === id && item.kind === "word");
  if (word) return [MIN_SIZE_PX, preset.frame.height];
  const list = edit.tracks.transitions.find((item) => item.id === id);
  if (list?.levels) {
    const key = list.levels.key.size;
    const sizes = LEVEL_ROLES.flatMap((role) => {
      const level = list.levels![role];
      return level ? [level.size] : [];
    });
    return [
      Math.ceil((MIN_SIZE_PX * key) / Math.min(...sizes)),
      Math.floor((MAX_TEXT_SIZE * key) / Math.max(...sizes)),
    ];
  }
  return null;
}

// The edit with the moves applied, nothing else changed. An accent, a question
// or the hook: its `position` (its box's top left corner, left-aligned, which
// draws the same as any other alignment of the same box) and its `size`. A big
// word: its `position` and `size`. A LIST: every level, moved with the box and
// scaled about its top left corner (each level's size and its offset inside
// the box times the key phrase's new size over its old one), at whole pixels.
// Refused with reasons: an id that is no text component of the edit (a caption
// and a VISUAL are not moved), a size outside the component's range.
export function applyOwnerMoves(
  edit: Edit,
  moves: readonly OwnerMove[],
  { transcript, preset, measurer }: Pick<Context, "transcript" | "preset" | "measurer">,
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const byId = new Map<string, OwnerMove>();
  for (const move of moves) {
    const range = ownerSizeRange(edit, move.id, preset);
    if (byId.has(move.id)) reasons.push(`${move.id}: moved twice`);
    else if (!range) reasons.push(`${move.id}: not a text component of this version`);
    else if (!Number.isInteger(move.size) || move.size < range[0] || move.size > range[1]) {
      reasons.push(`${move.id}: size ${move.size} is outside ${range[0]} to ${range[1]} px`);
    } else if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) {
      reasons.push(`${move.id}: its place is not a number`);
    }
    byId.set(move.id, move);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const levels = levelBoxes(
    edit,
    resolveTimeline(edit, transcript),
    new Map(transcript.words.map((word) => [word.id, word])),
    preset,
    measurer,
  );
  const overlays = edit.tracks.overlays.map((item) => {
    const move = byId.get(item.id);
    if (!move) return item;
    return {
      ...item,
      position: { x: move.x, y: move.y, align: "left" as const },
      size: move.size,
    };
  });
  const behind = edit.tracks.behind?.map((item) => {
    const move = byId.get(item.id);
    if (!move || item.kind !== "word") return item;
    return { ...item, position: { x: move.x, y: move.y }, size: move.size };
  });
  const transitions = edit.tracks.transitions.map((item) => {
    const move = byId.get(item.id);
    if (!move || !item.levels) return item;
    const own = levels.filter((level) => level.transitionId === item.id);
    const left = Math.min(...own.map((level) => level.x));
    const top = Math.min(...own.map((level) => level.y));
    const scale = move.size / item.levels.key.size;
    const moved = (role: (typeof LEVEL_ROLES)[number]): TransitionLevel | undefined => {
      const level = item.levels![role];
      const box = own.find((entry) => entry.role === role);
      if (!level || !box) return level;
      return {
        ...level,
        position: {
          x: Math.round(move.x + (box.x - left) * scale),
          y: Math.round(move.y + (box.y - top) * scale),
          align: "left",
        },
        size: role === "key" ? move.size : Math.round(level.size * scale),
      };
    };
    const number = moved("number");
    const lead = moved("lead");
    return {
      ...item,
      levels: {
        ...(number ? { number } : {}),
        ...(lead ? { lead } : {}),
        key: moved("key")!,
      },
    };
  });
  return {
    ok: true,
    edit: {
      ...edit,
      tracks: { ...edit.tracks, overlays, transitions, ...(behind ? { behind } : {}) },
    },
  };
}

// Where a box of this size sits nearest `at` inside the safe zone S and clear
// of the platform buttons' notch: clamped into S, then, when it still reaches
// the notch, moved the shorter way out of it (left of the column or above it).
// Null when the box is larger than S.
export function fitInSafeZone(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } | null {
  const { box: safe, notch } = SAFE_ZONE;
  if (box.width > safe.right - safe.left + SLACK || box.height > safe.bottom - safe.top + SLACK) {
    return null;
  }
  let x = Math.min(Math.max(box.x, safe.left), safe.right - box.width);
  let y = Math.min(Math.max(box.y, safe.top), safe.bottom - box.height);
  if (x + box.width > notch.left + SLACK && y + box.height > notch.top + SLACK) {
    const left = notch.left - box.width;
    const up = notch.top - box.height;
    const canLeft = left >= safe.left - SLACK;
    const canUp = up >= safe.top - SLACK;
    if (!canLeft && !canUp) return null;
    if (canLeft && (!canUp || x - left <= y - up)) x = left;
    else y = up;
  }
  return { x, y };
}

// Why a component's box breaks the owner's one hard rule: like every text, it
// stays inside the safe zone S and clear of the buttons' notch (what the
// platforms cover is never readable). Empty when it holds. Everything else
// (the face, other text) is the owner's choice; the version's checks record it.
export function ownerMoveProblems(
  components: readonly PlacedComponent[],
  ids: readonly string[],
): string[] {
  const { box: safe, notch } = SAFE_ZONE;
  const reasons: string[] = [];
  for (const id of ids) {
    const at = components.find((component) => component.id === id);
    if (!at) {
      reasons.push(`${id}: not on screen in this version`);
      continue;
    }
    const right = at.x + at.width;
    const bottom = at.y + at.height;
    if (
      at.x < safe.left - SLACK ||
      right > safe.right + SLACK ||
      at.y < safe.top - SLACK ||
      bottom > safe.bottom + SLACK
    ) {
      reasons.push(`${id}: runs past the safe zone`);
    } else if (right > notch.left + SLACK && bottom > notch.top + SLACK) {
      reasons.push(`${id}: runs into the platform button column`);
    }
  }
  return reasons;
}

function round(n: number): number {
  return Math.round(n);
}

// One move made legal, and the edit with it: the size brought into the
// component's range and shrunk until its box fits the safe zone, then the box
// moved the least it must to be inside the safe zone and clear of the notch,
// at whole pixels. What the studio shows after a drag and what the worker
// accepts are this same result. Refused when the id is no text component or
// its text fits nowhere in the safe zone even at its smallest size.
export function settleOwnerMove(
  edit: Edit,
  move: OwnerMove,
  context: Context,
): { ok: true; move: OwnerMove; edit: Edit } | { ok: false; reasons: string[] } {
  const range = ownerSizeRange(edit, move.id, context.preset);
  if (!range) return { ok: false, reasons: [`${move.id}: not a text component of this version`] };
  const { box: safe } = SAFE_ZONE;
  let size = Math.min(Math.max(round(move.size), range[0]), range[1]);
  let x = round(move.x);
  let y = round(move.y);
  // Each pass shrinks or moves; a text that still does not fit at its smallest
  // size ends the loop.
  for (let pass = 0; pass < 8; pass += 1) {
    const applied = applyOwnerMoves(edit, [{ id: move.id, x, y, size }], context);
    if (!applied.ok) return applied;
    const at = boxOf(applied.edit, move.id, context);
    if (!at) return { ok: false, reasons: [`${move.id}: not on screen in this version`] };
    const share = Math.min(
      (safe.right - safe.left) / at.width,
      (safe.bottom - safe.top) / at.height,
    );
    if (share < 1 - SLACK) {
      if (size <= range[0]) {
        return { ok: false, reasons: [`${move.id}: does not fit the safe zone at any size`] };
      }
      size = Math.max(range[0], Math.min(size - 1, Math.floor(size * share)));
      continue;
    }
    const spot = fitInSafeZone({ x: at.x, y: at.y, width: at.width, height: at.height });
    if (!spot) {
      if (size <= range[0]) {
        return { ok: false, reasons: [`${move.id}: does not fit the safe zone at any size`] };
      }
      size -= 1;
      continue;
    }
    // Whole pixels, the box kept inside: its left and top edges round up, and a
    // box whose right or bottom edge then passes the zone steps back one.
    const nx = Math.ceil(spot.x - SLACK);
    const ny = Math.ceil(spot.y - SLACK);
    const fx = nx + at.width > safe.right + SLACK ? nx - 1 : nx;
    const fy = ny + at.height > safe.bottom + SLACK ? ny - 1 : ny;
    if (Math.abs(fx - at.x) < SLACK && Math.abs(fy - at.y) < SLACK) {
      return { ok: true, move: { id: move.id, x, y, size }, edit: applied.edit };
    }
    x += fx - at.x;
    y += fy - at.y;
  }
  return { ok: false, reasons: [`${move.id}: no place inside the safe zone`] };
}

function boxOf(edit: Edit, id: string, context: Context): PlacedComponent | null {
  const { components } = build(
    edit,
    context.transcript,
    context.headTrack,
    context.preset,
    context.measurer,
    { layer: "front" },
  );
  return components.find((component) => component.id === id) ?? null;
}

// Whether a component's box or size differs from another placement of it.
function differs(a: PlacedComponent, b: PlacedComponent): { moved: boolean; resized: boolean } {
  return {
    moved: Math.abs(a.x - b.x) >= 0.5 || Math.abs(a.y - b.y) >= 0.5,
    resized: a.size !== b.size,
  };
}

// The moves that change something: a move whose corner and size are the
// component's own in `components` (the version being edited) is left out.
export function effectiveMoves(
  moves: readonly OwnerMove[],
  components: readonly PlacedComponent[],
): OwnerMove[] {
  return moves.filter((move) => {
    const at = components.find((component) => component.id === move.id);
    if (!at) return true;
    return (
      Math.abs(at.x - move.x) >= 0.5 || Math.abs(at.y - move.y) >= 0.5 || at.size !== move.size
    );
  });
}

// The big words' `cutout` after a move: whether the head reaches the word over
// its padded span, the layout engine's own rule (`bigWordNeedsCutout`). A word
// moved above the head is plain text with no mask; one moved onto the head
// goes behind the speaker and needs a mask, which only the worker can make, so
// the worker calls this before it saves and the studio's draft does not.
export function withOwnerCutouts(
  edit: Edit,
  ids: readonly string[],
  { transcript, headTrack, preset, measurer }: Context,
): Edit {
  const behind = edit.tracks.behind;
  if (!behind || !behind.some((item) => item.kind === "word" && ids.includes(item.id))) {
    return edit;
  }
  const resolved = resolveTimeline(edit, transcript);
  return {
    ...edit,
    tracks: {
      ...edit.tracks,
      behind: behind.map((item) => {
        if (item.kind !== "word" || !ids.includes(item.id)) return item;
        const span = resolved.get(item.id);
        if (!span || !item.position || !item.size) return item;
        const at = placedBigWord(item, item.position, item.size, measurer);
        const box: Box = {
          left: at.x,
          right: at.x + at.width,
          top: at.y,
          bottom: at.y + at.height,
        };
        return {
          ...item,
          cutout: bigWordNeedsCutout(box, headTrack, paddedSpan(span, edit.duration, preset)),
        };
      }),
    },
  };
}

// A box and a text size, as the learning record stores a placement.
export interface RecordedPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  size: number | null;
}

// One component the owner moved or resized, for learning placement rules
// later (the `owner_moves` table): where the engine placed it, where the owner
// put it, and what was on screen with it at that moment.
export interface OwnerMoveRecord {
  item: string;
  component: EngineComponent;
  // The entry the engine placed it with ("accent/above-head"), when its record
  // names one.
  variant: string | null;
  text: string;
  start: number;
  end: number;
  engine: RecordedPlacement;
  owner: RecordedPlacement;
  moved: boolean;
  resized: boolean;
  context: {
    frame: { width: number; height: number };
    font_pair: string;
    // The head over the component's time on screen: the box around the robust
    // faces of the head track (`facesOver`); null with no head.
    head: Box | null;
    // The zone the engine took for it, when its record names one.
    engine_zone: string | null;
    // Everything else on screen during its time, where the owner's version has
    // it; `moved_by_owner` when that is not where the engine placed it.
    others: {
      item: string;
      component: EngineComponent;
      text: string;
      start: number;
      end: number;
      box: RecordedPlacement;
      moved_by_owner: boolean;
    }[];
  };
}

function placementOf(at: PlacedComponent): RecordedPlacement {
  return { x: at.x, y: at.y, width: at.width, height: at.height, size: at.size };
}

// The learning records of one save: one per moved id whose place or size is
// not the engine's. `engine` holds the components where the layout engine
// placed them (the engine-placed version the owner's edits started from),
// `owner` the components of the version being saved.
export function ownerMoveRecords({
  ids,
  engine,
  owner,
  edit,
  headTrack,
  preset,
  engineRecord = [],
}: {
  ids: readonly string[];
  engine: readonly PlacedComponent[];
  owner: readonly PlacedComponent[];
  edit: Pick<Edit, "font_pair">;
  headTrack: HeadTrack;
  preset: Preset;
  engineRecord?: readonly EngineNote[];
}): OwnerMoveRecord[] {
  const placed = new Map(engine.map((component) => [component.id, component]));
  const records: OwnerMoveRecord[] = [];
  for (const id of ids) {
    const mine = owner.find((component) => component.id === id);
    const theirs = placed.get(id);
    if (!mine || !theirs) continue;
    const change = differs(mine, theirs);
    if (!change.moved && !change.resized) continue;
    const note = engineRecord.find((entry) => entry.item === id && entry.zone !== undefined);
    const variant = engineRecord.find((entry) => entry.item === id)?.variant ?? null;
    records.push({
      item: id,
      component: mine.component,
      variant,
      text: mine.text,
      start: mine.start,
      end: mine.end,
      engine: placementOf(theirs),
      owner: placementOf(mine),
      ...change,
      context: {
        frame: { width: preset.frame.width, height: preset.frame.height },
        font_pair: edit.font_pair,
        head: boundingBox(facesOver(headTrack, mine.start, mine.end)),
        engine_zone: note?.zone ?? null,
        others: owner
          .filter(
            (other) =>
              other.id !== id && other.start < mine.end - SLACK && mine.start < other.end - SLACK,
          )
          .map((other) => {
            const was = placed.get(other.id);
            const otherChange = was ? differs(other, was) : { moved: false, resized: false };
            return {
              item: other.id,
              component: other.component,
              text: other.text,
              start: other.start,
              end: other.end,
              box: placementOf(other),
              moved_by_owner: otherChange.moved || otherChange.resized,
            };
          }),
      },
    });
  }
  return records;
}
