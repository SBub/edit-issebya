import type { Backgrounds } from "./background.ts";
import { spotBox, spotFaceShare } from "./behind.ts";
import { contrastRatio, relativeLuminance } from "./contrast.ts";
import type {
  AccentChoice,
  BigWordChoice,
  EngineInput,
  PhotoChoice,
  TransitionChoice,
  Wish,
} from "./engine-input.ts";
import { expand, overlaps, placeBox } from "./engine-space.ts";
import { type Box, type HeadTrack, LAYOUT_PADDING, boundingBox, facesOver } from "./head-track.ts";
import { wordsText } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import {
  BEHIND_SPOTS,
  type BehindSpot,
  type FontKey,
  PLATFORM_BUTTONS,
  type Preset,
  cleanWord,
  intersectBox,
} from "./preset.ts";
import {
  type Anchor,
  BEHIND_WORD,
  type BehindItem,
  type CaptionItem,
  type Edit,
  type OverlayItem,
  type TransitionItem,
  type TransitionLevel,
} from "./schema.ts";
import { anchorAt, resolveAnchor } from "./timeline.ts";
import { type LevelRole, levelStyle, transitionTiming } from "./transitions.ts";
import { type SentenceSpan, type Transcript, type Word, sentenceSpans } from "./transcript.ts";

// THE LAYOUT ENGINE. Claude's answer says what and on which words; this code
// decides every time, position and size, with no randomness and no I/O:
//
// 1. Timing first: captions per spoken word, a transition from its phrase's
//    words (its entrance finishing as the first word starts, gone when the
//    next word starts, at most a hold after the last, at least its minimum,
//    about one per `perSeconds`, never two at once), an accent from its first
//    word to a second after its last, the big word from its word to the end
//    of its sentence, a photo over its sentence, each at least its minimum.
// 2. The scene: the reel cut into moments wherever an item starts or ends,
//    each with its face (robust over the head track, never one reading).
// 3. Free space: an area minus the face, the platform notch and the text
//    already placed, as rectangles (`engine-space.ts`).
// 4. Placement by priority: each transition's text levels (its phrase's
//    captions, shown only there), captions (one spot per sentence), then the
//    items the request is about, accents, the big word, photos; at most one
//    of these extras at a time, none during a transition. Text shrinks to the
//    preset's floor and wraps to two lines before it gives up a place.
//    Nothing ever overlaps.
// 5. An extra that fits nowhere is dropped; captions never are (in the worst
//    case they take the caption line over the face).
// 6. Readable text: with a background map, each text placed is measured
//    (WCAG contrast of its colour against the footage behind it, over its
//    span). Below the preset's threshold it moves to the nearest free place
//    in the same zone that reaches it, else keeps its place with a soft
//    shadow. A colour is never changed; the big word is never moved for it.
// 7. Every move, shrink, wrap, retime, drop and shadow is written to the
//    record.

// What the engine did to an item, in plain words.
export type EngineAction =
  | "moved"
  | "shrunk"
  | "wrapped"
  | "retimed"
  | "dropped"
  | "covers-face"
  | "wish-not-kept"
  | "shadowed"
  // An extra Claude added on its own, taken out to make room for an item the
  // owner asked for.
  | "removed";

export interface EngineNote {
  item: string;
  action: EngineAction;
  rule: string;
  reason: string;
}

export type PlacedTracks = Omit<Edit["tracks"], "cutout">;

// The kinds of extra the engine may leave out.
export type ExtraKind = "accent" | "big_word" | "photo";

// Why an extra was left out, as a code in editor terms (never a time or a
// pixel): no free place, another extra shows then, its sentence is too short,
// the footage is hidden there.
export type UnplacedWhy = "no-room" | "busy" | "too-short" | "hidden";

// An answer item the placement left out: its answer reference, its item id,
// the words it was on (the big word: its word twice) and, for a photo, which.
export interface UnplacedItem {
  ref: string;
  id: string;
  kind: ExtraKind;
  from: string;
  to: string;
  photo_id?: string;
  // Whether the owner's request asked for it.
  requested: boolean;
  why: UnplacedWhy;
}

// A sentence (by its first and last word ids) with room, after the
// placement, for the kinds of extra some left-out item has. A hint for the
// editor, never a promise: what it picks is placed again for real.
export interface FreeSentence {
  from: string;
  to: string;
  room_for: ExtraKind[];
}

export interface Placement {
  tracks: PlacedTracks;
  record: EngineNote[];
  // The answer's extras left out, and where an extra of their kind fits.
  unplaced: UnplacedItem[];
  free: FreeSentence[];
}

export interface PlaceOptions {
  // The answer items the owner's request asks for (`accents[0]`, `big_word`,
  // `photos[1]`): placed before every other extra.
  requested?: readonly string[];
  // What is behind the text (the footage's background map, sampled): with it
  // every text is kept readable; without it nothing is measured.
  backgrounds?: Backgrounds;
}

type Align = "left" | "right" | "center";

interface Shown {
  id: string;
  start: number;
  end: number;
  box: Box;
}

const SLACK = 1e-6;

function ms(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

function at(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 37)}...` : text);
}

// A contrast ratio in the record: one decimal, never rounded up to a
// threshold it does not reach.
function ratioText(ratio: number): string {
  return `${(Math.floor(ratio * 10 + 1e-9) / 10).toFixed(1)}:1`;
}

function during(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end - SLACK && b.start < a.end - SLACK;
}

// The sizes a text tries, from its own down to the preset's floor.
function sizesFrom(size: number, preset: Preset): number[] {
  const floor = Math.ceil(size * preset.layout.minScale);
  const out: number[] = [];
  for (let step = 0; ; step += 1) {
    const next = Math.round(size * (1 - step * 0.1));
    if (next < floor) break;
    if (!out.includes(next)) out.push(next);
  }
  if (!out.includes(floor)) out.push(floor);
  return out;
}

// ---------------------------------------------------------------- the scene

interface Moment {
  start: number;
  end: number;
  // The face (padded for text) over the moment; null with no head.
  face: Box | null;
}

// The reel cut at every item edge; each moment's face is the bounding box of
// the robust faces around it.
function sceneOf(edges: readonly number[], duration: number, headTrack: HeadTrack): Moment[] {
  const cuts = [...new Set([0, ms(duration), ...edges.map(ms)])]
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b);
  const moments: Moment[] = [];
  for (let index = 1; index < cuts.length; index += 1) {
    const start = cuts[index - 1]!;
    const end = cuts[index]!;
    const face = boundingBox(facesOver(headTrack, start - 0.25, end + 0.25, LAYOUT_PADDING));
    moments.push({ start, end, face });
  }
  return moments;
}

function facesDuring(scene: readonly Moment[], span: { start: number; end: number }): Box[] {
  const out: Box[] = [];
  for (const moment of scene) {
    if (moment.face && moment.start < span.end && span.start < moment.end) out.push(moment.face);
  }
  return out;
}

// ---------------------------------------------------------------- captions

interface Unit {
  index: number;
  caption: CaptionItem;
  text: string;
  start: number;
  lastWord: Word;
}

interface CaptionBlock {
  groups: Unit[][];
  start: number;
  end: number;
}

// The current captions as groups (one set of words on screen: consecutive
// captions ending on the same anchor), re-timed: a group leaves at its last
// word's end, held so its last caption shows at least the preset's minimum,
// never past the next group's start; a last caption that cannot show that
// long joins the next group.
function captionGroups(
  captions: readonly CaptionItem[],
  texts: readonly string[],
  transcript: Transcript,
  duration: number,
  preset: Preset,
  record: EngineNote[],
): { groups: Unit[][]; ends: number[] } {
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const groups: Unit[][] = [];
  let key = "";
  captions.forEach((caption, index) => {
    const unit: Unit = {
      index,
      caption,
      text: texts[index]!,
      start: resolveAnchor(caption.start, words, duration),
      lastWord: words.get(caption.words.at(-1)!)!,
    };
    const end = JSON.stringify(caption.end);
    const last = groups.at(-1);
    if (last && end === key) last.push(unit);
    else groups.push([unit]);
    key = end;
  });
  const min = preset.caption.minSeconds;
  for (let index = groups.length - 2; index >= 0; index -= 1) {
    const group = groups[index]!;
    const next = groups[index + 1]!;
    while (group.length > 0 && next[0]!.start - group.at(-1)!.start < min - SLACK) {
      const moved = group.pop()!;
      next.unshift(moved);
      record.push({
        item: moved.caption.id,
        action: "retimed",
        rule: "caption-min",
        reason: `caption ${quote(moved.text)} joins the next group, so it shows at least ${min} s`,
      });
    }
    if (group.length === 0) groups.splice(index, 1);
  }
  const ends = groups.map((group, index) => {
    const lastWord = group.at(-1)!.lastWord;
    const next = groups[index + 1]?.[0]?.start ?? duration;
    const end = ms(Math.min(next, duration, Math.max(lastWord.end, group.at(-1)!.start + min)));
    if (end > lastWord.end + 0.0005) {
      record.push({
        item: group.at(-1)!.caption.id,
        action: "retimed",
        rule: "caption-min",
        reason: `caption ${quote(group.at(-1)!.text)} stays until ${at(end)}, at least ${min} s on screen`,
      });
    }
    return end;
  });
  return { groups, ends };
}

interface Candidate {
  name: string;
  area: Box;
  align: Align;
  want: (width: number, height: number) => { x: number; y: number };
  maxLines: number;
  // The worst case: the face is no obstacle.
  overFace?: boolean;
}

interface Line {
  units: { unit: Unit; width: number }[];
  width: number;
}

function wrapUnits(
  units: readonly Unit[],
  font: FontKey,
  size: number,
  width: number,
  maxLines: number,
  measurer: Measurer,
): Line[] | null {
  const space = measurer.width(font, size, " ");
  const lines: Line[] = [];
  for (const unit of units) {
    const w = measurer.width(unit.caption.font ?? font, size, unit.text);
    if (w > width) return null;
    const line = lines.at(-1);
    if (line && line.width + space + w <= width) {
      line.units.push({ unit, width: w });
      line.width += space + w;
    } else {
      lines.push({ units: [{ unit, width: w }], width: w });
      if (lines.length > maxLines) return null;
    }
  }
  return lines;
}

// ---------------------------------------------------------------- the engine

interface Extra {
  ref: string;
  // `transition`: a running transition, accepted before every extra.
  kind: ExtraKind | "transition";
  id: string;
  start: number;
  end: number;
  min: number;
  wish?: Wish;
  // Its place in the answer's list (0 for the big word).
  index: number;
  // A start moved inside its sentence to make room: the word it starts on.
  startWord?: string;
  accent?: AccentChoice;
  photo?: PhotoChoice;
  word?: string;
}

// A transition kept by the timing rules: its answer item and its layer's span.
interface TransitionPlan {
  ref: string;
  index: number;
  id: string;
  label: string;
  choice: TransitionChoice;
  wish?: "slow" | "long";
  start: number;
  end: number;
  startAnchor: Anchor;
  endAnchor: Anchor;
}

interface Accepted {
  extra: Extra;
  start: number;
  end: number;
}

// What one pass may do to make room for the items the owner asked for
// (empty: the plain pass, exactly the engine without a request).
interface Room {
  // Requested items placed before the captions; the caption blocks sharing
  // their time keep clear of them, at the full size only (`move`) or down to
  // the floor (`shrink`), never over the face. A photo's spot is pinned.
  reserve: ReadonlyMap<string, "move" | "shrink">;
  spot: ReadonlyMap<string, BehindSpot>;
  // Extras Claude added on its own, left out (answer refs, transitions too).
  removed: ReadonlySet<string>;
  // A requested item's span moved inside its sentence.
  shift: ReadonlyMap<string, { word?: string; end: number }>;
  // Requested items that may cover the face.
  faceOk: ReadonlySet<string>;
  // Caption blocks (by first caption id) the plain pass put over the face:
  // the only ones that may stay there while room is made.
  overFace: ReadonlySet<string>;
}

const PLAIN: Room = {
  reserve: new Map(),
  spot: new Map(),
  removed: new Set(),
  shift: new Map(),
  faceOk: new Set(),
  overFace: new Set(),
};

// One caption block as a pass placed it.
interface BlockPlace {
  label: string;
  start: number;
  end: number;
  name: string;
  size: number;
  x: number;
  y: number;
}

// One deterministic pass and what the ladder compares between passes.
interface Pass {
  tracks: PlacedTracks;
  record: EngineNote[];
  unplaced: UnplacedItem[];
  // Probes run after the pass, never committing anything.
  free: () => FreeSentence[];
  // The answer refs placed.
  placed: Set<string>;
  // The extras' own spans and their labels, by answer ref.
  extras: Map<string, Extra>;
  labels: Map<string, string>;
  transitions: { ref: string; label: string; start: number; end: number }[];
  // Caption blocks by their first caption's id.
  blocks: Map<string, BlockPlace>;
  // Caption ids the pass put over the face.
  facesCovered: Set<string>;
  // A caption block sharing a reserved item's time found no place clear of it.
  failed: boolean;
}

const MAKE_ROOM_TAIL =
  ", after moving and shrinking captions, removing extras, shifting it in its sentence and allowing the face";

// Places every item of an answer over the current version: footage and
// sounds kept, captions from the current version's words (each fix as the
// text of the caption showing that word), every other item from its words.
// Without a request this is one plain pass. With one, each requested item
// (in the checklist's order) that the plain pass leaves out gets room, step
// by step until it is placed: the captions sharing its time move (full
// size), then shrink or wrap down to the floor, then extras Claude added on
// its own that stand in the way are removed, then it shifts inside its
// sentence, then it may cover the face. A step's pass is taken only when the
// item is placed, every requested item placed before stays placed and no
// caption block goes over the face that did not already. Every step taken is
// recorded under the rule `make-room`; nothing found, its drop stands.
export function placeEdit(
  current: Edit,
  input: EngineInput,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  options: PlaceOptions = {},
): Placement {
  const run = (room: Room) =>
    placeOnce(current, input, transcript, headTrack, preset, measurer, options, room);
  const plain = run(PLAIN);
  const requested = options.requested ?? [];
  let pass = plain;
  let room: Room = { ...PLAIN, overFace: plain.facesCovered };
  const notes: EngineNote[] = [];
  const done: string[] = [];
  const sentences = sentenceSpans(transcript);
  const order = new Map(transcript.words.map((w, index) => [w.id, index]));
  const byId = new Map(transcript.words.map((w) => [w.id, w]));
  const sentenceOf = (id: string) =>
    sentences.find(
      (s) => order.get(s.from)! <= order.get(id)! && order.get(id)! <= order.get(s.to)!,
    );
  const hidden = current.tracks.footage.flatMap((clip) =>
    (clip.hidden ?? []).map((span) => ({
      start: resolveAnchor(span.start, byId, current.duration),
      end: resolveAnchor(span.end, byId, current.duration),
    })),
  );
  const crossesHidden = (span: { start: number; end: number }) =>
    hidden.some((range) => during(span, range));

  for (const ref of requested) {
    const extra = plain.extras.get(ref);
    if (!extra) continue;
    if (pass.placed.has(ref)) {
      done.push(ref);
      continue;
    }
    const before = pass;
    const accept = (next: Pass) =>
      !next.failed &&
      next.placed.has(ref) &&
      done.every((other) => next.placed.has(other)) &&
      [...next.facesCovered].every((id) => plain.facesCovered.has(id));
    const attempt = (next: Room): { room: Room; pass: Pass } | null => {
      const tried = run(next);
      return accept(tried) ? { room: next, pass: tried } : null;
    };
    const span = { start: extra.start, end: extra.end };
    const spotsFor = (
      faceOk: boolean,
      at: { start: number; end: number },
    ): (BehindSpot | undefined)[] => {
      if (extra.kind !== "photo") return [undefined];
      const kept = (current.tracks.behind ?? []).find(
        (item) => item.kind === "photo" && item.photo_id === extra.photo!.photo_id,
      );
      const wished = BEHIND_SPOTS.find((spot) => spot === extra.wish);
      const spots: BehindSpot[] = [
        ...new Set([
          ...(wished ? [wished] : []),
          ...(kept?.kind === "photo" ? [kept.spot] : []),
          ...BEHIND_SPOTS,
        ]),
      ];
      if (!faceOk) return spots.filter((spot) => spotClearOfFace(spot, at, preset, headTrack));
      const share = (spot: BehindSpot) =>
        Math.max(
          0,
          ...facesOver(headTrack, at.start, at.end).map((face) =>
            spotFaceShare(spot, face, preset),
          ),
        );
      return spots
        .map((spot, index) => ({ spot, index, share: share(spot) }))
        .sort((a, b) => a.share - b.share || a.index - b.index)
        .map(({ spot }) => spot);
    };
    const withRef = (
      base: Room,
      mode: "move" | "shrink",
      spot: BehindSpot | undefined,
      more: Partial<Pick<Room, "removed" | "shift" | "faceOk">> = {},
    ): Room => ({
      reserve: new Map([...base.reserve, [ref, mode]]),
      spot: spot ? new Map([...base.spot, [ref, spot]]) : base.spot,
      removed: more.removed ?? base.removed,
      shift: more.shift ?? base.shift,
      faceOk: more.faceOk ?? base.faceOk,
      overFace: base.overFace,
    });
    // Move, then shrink, at every spot the face leaves clear.
    const moveOrShrink = (base: Room, removed: ReadonlySet<string>) => {
      for (const mode of ["move", "shrink"] as const) {
        for (const spot of spotsFor(false, span)) {
          const found = attempt(withRef(base, mode, spot, { removed }));
          if (found) return found;
        }
      }
      return null;
    };
    let found = moveOrShrink(room, room.removed);
    // Claude's own extras overlapping its time, one at a time in a fixed
    // order (accents, the big word, transitions), each followed by the moves.
    const removable = [
      ...[...plain.extras.values()]
        .filter((other) => other.kind === "accent")
        .map((other) => ({ ref: other.ref, start: other.start, end: other.end })),
      ...[...plain.extras.values()]
        .filter((other) => other.kind === "big_word")
        .map((other) => ({ ref: other.ref, start: other.start, end: other.end })),
      ...plain.transitions,
    ]
      .filter((other) => !requested.includes(other.ref) && !room.removed.has(other.ref))
      .filter((other) => during(other, span))
      .map((other) => other.ref);
    const removed = new Set(room.removed);
    if (!found) {
      for (const other of removable) {
        removed.add(other);
        found = moveOrShrink(room, removed);
        if (found) break;
      }
      // Put back every removal the room turns out not to need.
      if (found) {
        for (const other of removable) {
          if (!found.room.removed.has(other)) continue;
          const fewer = new Set([...found.room.removed].filter((r) => r !== other));
          const again = attempt({ ...found.room, removed: fewer });
          if (again) found = again;
        }
      }
    }
    // Its timing inside its own sentence.
    if (!found) {
      for (const shift of shiftsOf(extra)) {
        const at = {
          start: shift.word ? byId.get(shift.word)!.start : extra.start,
          end: shift.end,
        };
        for (const spot of spotsFor(false, at)) {
          found = attempt(
            withRef(room, "shrink", spot, {
              removed,
              shift: new Map([...room.shift, [ref, shift]]),
            }),
          );
          if (found) break;
        }
        if (found) break;
      }
    }
    // Last: over the face.
    if (!found) {
      for (const spot of spotsFor(true, span)) {
        found = attempt(
          withRef(room, "shrink", spot, { removed, faceOk: new Set([...room.faceOk, ref]) }),
        );
        if (found) break;
      }
    }
    if (!found) {
      // The drop stands, with every step it took.
      pass = {
        ...pass,
        record: pass.record.map((note) =>
          note.item === extra.id && note.action === "dropped"
            ? { ...note, reason: `${note.reason}${MAKE_ROOM_TAIL}` }
            : note,
        ),
      };
      continue;
    }
    notes.push(...roomNotes(ref, before, found.pass, room, found.room));
    room = found.room;
    pass = found.pass;
    done.push(ref);
  }

  // A requested item's span moved inside its sentence: each word start
  // nearest the original first, at least the kind's minimum, never into the
  // next sentence or over hidden footage. The big word only shortens.
  function shiftsOf(extra: Extra): { word?: string; end: number }[] {
    const duration = current.duration;
    if (extra.kind === "big_word") {
      const end = ms(extra.start + extra.min);
      return end < extra.end - SLACK ? [{ end }] : [];
    }
    const from = extra.kind === "accent" ? extra.accent!.from : extra.photo!.from;
    const sentence = sentenceOf(from);
    if (!sentence) return [];
    const at = sentences.indexOf(sentence);
    const hi = Math.min(duration, sentences[at + 1]?.start ?? duration);
    const ids = transcript.words
      .slice(order.get(sentence.from)!, order.get(sentence.to)! + 1)
      .filter((w) => Math.abs(w.start - extra.start) > 0.0005)
      .sort(
        (a, b) =>
          Math.abs(a.start - extra.start) - Math.abs(b.start - extra.start) ||
          order.get(a.id)! - order.get(b.id)!,
      );
    const out: { word: string; end: number }[] = [];
    for (const w of ids) {
      const start = w.start;
      let end: number;
      if (extra.kind === "photo") {
        const { minSeconds, maxSeconds } = preset.behind;
        end = Math.min(start + maxSeconds, Math.max(sentence.end, start + minSeconds));
      } else {
        const to = byId.get(extra.accent!.to)!;
        end =
          start <= to.start
            ? Math.max(to.end + preset.accent.afterSeconds, start + preset.accent.minSeconds)
            : start + preset.accent.minSeconds;
      }
      end = ms(end);
      if (end > hi + SLACK || end - start < extra.min - SLACK) continue;
      if (crossesHidden({ start, end })) continue;
      out.push({ word: w.id, end });
    }
    return out;
  }

  return {
    tracks: pass.tracks,
    record: [...pass.record, ...notes],
    unplaced: pass.unplaced,
    free: pass.free(),
  };
}

// The `make-room` notes of one requested item: what its accepted pass did
// that the pass before it did not.
function roomNotes(ref: string, before: Pass, after: Pass, was: Room, now: Room): EngineNote[] {
  const notes: EngineNote[] = [];
  const label = after.labels.get(ref)!;
  const extra = after.extras.get(ref)!;
  for (const other of now.removed) {
    if (was.removed.has(other)) continue;
    const transition = before.transitions.find((t) => t.ref === other);
    const id = transition
      ? `transition-${Number(/\d+/.exec(other)![0]) + 1}`
      : before.extras.get(other)!.id;
    const what = transition ? transition.label : before.labels.get(other)!;
    notes.push({
      item: id,
      action: "removed",
      rule: "make-room",
      reason: `${what} removed: it showed at the same time as ${label}, as asked`,
    });
  }
  for (const [id, place] of after.blocks) {
    const old = before.blocks.get(id);
    if (!old) continue;
    const captions = `captions ${quote(place.label)} (${at(place.start)} to ${at(place.end)})`;
    if (place.name !== old.name || place.x !== old.x || place.y !== old.y) {
      notes.push({
        item: id,
        action: "moved",
        rule: "make-room",
        reason: `${captions} move to make room for ${label}: they sit ${place.name}, as asked`,
      });
    }
    if (place.size < old.size) {
      notes.push({
        item: id,
        action: "shrunk",
        rule: "make-room",
        reason: `${captions} set at ${place.size} px instead of ${old.size} px to make room for ${label}, as asked`,
      });
    }
  }
  const shift = now.shift.get(ref);
  if (shift && was.shift.get(ref) !== shift) {
    notes.push({
      item: extra.id,
      action: "retimed",
      rule: "make-room",
      reason: `${label} now shows from ${at(after.extras.get(ref)!.start)} to ${at(shift.end)}, inside its sentence, to find room`,
    });
  }
  if (now.faceOk.has(ref) && !was.faceOk.has(ref)) {
    const photo = after.tracks.behind?.find((item) => item.id === extra.id);
    notes.push({
      item: extra.id,
      action: "covers-face",
      rule: "make-room",
      reason:
        photo?.kind === "photo"
          ? `${label} sits in the ${photo.spot} spot over part of the face: nothing else was free, as asked`
          : `${label} sits over part of the face: nothing else was free, as asked`,
    });
  }
  return notes;
}

function placeOnce(
  current: Edit,
  input: EngineInput,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  options: PlaceOptions,
  room: Room,
): Pass {
  const record: EngineNote[] = [];
  const duration = current.duration;
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const word = (id: string) => byId.get(id)!;
  const order = new Map(transcript.words.map((w, index) => [w.id, index]));
  const range = (from: string, to: string) =>
    transcript.words.slice(order.get(from)!, order.get(to)! + 1).map((w) => w.id);
  const sentences = sentenceSpans(transcript);
  const sentenceOf = (id: string): SentenceSpan | undefined => {
    const index = order.get(id)!;
    return sentences.find((s) => order.get(s.from)! <= index && index <= order.get(s.to)!);
  };
  const { safe, layout } = preset;
  const gap = layout.gap;
  const notch = PLATFORM_BUTTONS;
  const safeCx = (safe.left + safe.right) / 2;
  const hidden = current.tracks.footage.flatMap((clip) =>
    (clip.hidden ?? []).map((span) => ({
      start: resolveAnchor(span.start, byId, duration),
      end: resolveAnchor(span.end, byId, duration),
    })),
  );
  let failed = false;
  const requested = options.requested ?? [];

  // Fixes, then the captions' times.
  const fixes = new Map(input.word_fixes.map((fix) => [fix.word, fix.text]));
  const captions = current.tracks.captions.map((caption) => {
    const rest: CaptionItem = { ...caption };
    delete rest.text;
    delete rest.position;
    delete rest.size;
    delete rest.break_after;
    delete rest.shadow;
    const fixed = caption.words.filter((id) => fixes.has(id)).map((id) => fixes.get(id)!);
    return fixed.length > 0 ? { ...rest, text: fixed.join(" ") } : rest;
  });
  const texts = captions.map(
    (caption) => caption.text ?? wordsText(caption.words, transcript, preset),
  );
  const { groups, ends } = captionGroups(captions, texts, transcript, duration, preset, record);
  const unitEnd = new Map<number, number>();
  const unitEndWord = new Map<number, Word>();
  groups.forEach((group, index) => {
    for (const unit of group) {
      unitEnd.set(unit.index, ends[index]!);
      unitEndWord.set(unit.index, group.at(-1)!.lastWord);
    }
  });

  // Transitions, timed first from their words: the requested ones, then the
  // answer's order; about one per `perSeconds` of reel; never two at once.
  const transitionPlans = timeTransitions();

  function transitionText(choice: TransitionChoice): string {
    return wordsText(range(choice.from, choice.to), transcript, preset);
  }

  function timeTransitions(): TransitionPlan[] {
    const { transition: rules } = preset;
    const most = Math.max(1, Math.round(duration / rules.perSeconds));
    const order = input.transitions
      .map((choice, index) => ({ choice, index, ref: `transitions[${index}]` }))
      .filter(({ ref }) => !room.removed.has(ref))
      .sort((a, b) => {
        const ra = requested.indexOf(a.ref);
        const rb = requested.indexOf(b.ref);
        return (ra < 0 ? 1e6 : ra) - (rb < 0 ? 1e6 : rb) || a.index - b.index;
      });
    const kept: TransitionPlan[] = [];
    for (const { choice, index, ref } of order) {
      const id = `transition-${index + 1}`;
      const label = `transition ${index + 1} (${choice.kind}) on ${quote(transitionText(choice))}`;
      const wish = choice.wish === "slow" || choice.wish === "long" ? choice.wish : undefined;
      if (choice.wish !== undefined && !wish) {
        record.push({
          item: id,
          action: "wish-not-kept",
          rule: "wish",
          reason: `${label} cannot go ${choice.wish.replace("_", " ")}: a transition only moves slower or stays longer`,
        });
      }
      const kind = preset.transitions[choice.kind];
      const timing = transitionTiming(
        { from: choice.from, to: choice.to, ...(wish ? { wish } : {}) },
        transcript.words,
        duration,
        preset,
        kind,
      );
      if (!timing) {
        record.push({
          item: id,
          action: "dropped",
          rule: "transition-time",
          reason: `${label} dropped: the reel is too short to show it ${rules.minSeconds} s`,
        });
        continue;
      }
      if (kept.length >= most) {
        record.push({
          item: id,
          action: "dropped",
          rule: "transition-rate",
          reason: `${label} dropped: about one transition per ${rules.perSeconds} s, this reel has room for ${most}`,
        });
        continue;
      }
      // Never two at once: the earlier one leaves as the later comes in, when
      // it still lasts the minimum and its key phrase shows; else the one
      // being added is dropped.
      const keyStart = (plan: { choice: TransitionChoice }) => word(plan.choice.key_from).start;
      const holds = (plan: { start: number; choice: TransitionChoice }, end: number) =>
        end - plan.start >= rules.minSeconds - SLACK &&
        end - keyStart(plan) >= preset.caption.minSeconds - SLACK;
      let end = timing.end;
      let endAnchor = timing.endAnchor;
      const trims: { plan: TransitionPlan; end: number }[] = [];
      let clash: TransitionPlan | null = null;
      for (const other of [...kept].sort((a, b) => a.start - b.start)) {
        if (!during({ start: timing.start, end }, other)) continue;
        if (other.start < timing.start - SLACK) {
          if (!holds(other, timing.start)) {
            clash = other;
            break;
          }
          trims.push({ plan: other, end: timing.start });
        } else {
          if (!holds({ start: timing.start, choice }, other.start)) {
            clash = other;
            break;
          }
          end = other.start;
          endAnchor = anchorAt(end, transcript.words);
        }
      }
      if (clash) {
        record.push({
          item: id,
          action: "dropped",
          rule: "transition-overlap",
          reason: `${label} dropped: it would show at the same time as ${clash.label} (${at(clash.start)} to ${at(clash.end)}); one transition at a time`,
        });
        continue;
      }
      for (const trim of trims) {
        trim.plan.end = trim.end;
        trim.plan.endAnchor = anchorAt(trim.end, transcript.words);
        record.push({
          item: trim.plan.id,
          action: "retimed",
          rule: "transition-overlap",
          reason: `${trim.plan.label} leaves at ${at(trim.end)}, when ${label} comes in`,
        });
      }
      if (end < timing.end - SLACK) {
        record.push({
          item: id,
          action: "retimed",
          rule: "transition-overlap",
          reason: `${label} leaves at ${at(end)}, before the next transition comes in`,
        });
      }
      if (timing.lengthened) {
        record.push({
          item: id,
          action: "retimed",
          rule: "transition-min",
          reason: `${label} shows from ${at(timing.start)} to ${at(timing.end)}, at least ${rules.minSeconds} s`,
        });
      }
      kept.push({
        ref,
        index,
        id,
        label,
        choice,
        ...(wish ? { wish } : {}),
        start: timing.start,
        end,
        startAnchor: timing.startAnchor,
        endAnchor,
      });
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  // The extras' own times (before the one-at-a-time rule). A time that
  // cannot hold the item drops it into `notes` (none for a probe).
  const { minSeconds, maxSeconds } = preset.behind;
  const crossesHidden = (span: { start: number; end: number }) =>
    hidden.some((range) => during(span, range));

  function accentExtra(
    accent: AccentChoice,
    index: number,
    id: string,
    notes: EngineNote[] | null,
  ): Extra | null {
    const ref = `accents[${index}]`;
    const shift = notes ? room.shift.get(ref) : undefined;
    const start = word(shift?.word ?? accent.from).start;
    const end = shift
      ? shift.end
      : ms(
          Math.min(
            duration,
            Math.max(
              word(accent.to).end + preset.accent.afterSeconds,
              start + preset.accent.minSeconds,
            ),
          ),
        );
    if (end - start < preset.accent.minSeconds - SLACK) {
      notes?.push({
        item: id,
        action: "dropped",
        rule: "accent-time",
        reason: `accent ${quote(accentText(accent))} starts too close to the end to show ${preset.accent.minSeconds} s`,
      });
      return null;
    }
    return {
      ref,
      kind: "accent",
      id,
      start,
      end,
      min: preset.accent.minSeconds,
      ...(accent.wish ? { wish: accent.wish } : {}),
      index,
      ...(shift?.word ? { startWord: shift.word } : {}),
      accent,
    };
  }

  function bigWordExtra(choice: BigWordChoice, notes: EngineNote[] | null): Extra | null {
    const first = word(choice.word);
    const sentence = sentenceOf(first.id);
    const shift = notes ? room.shift.get("big_word") : undefined;
    const end =
      shift?.end ??
      ms(
        Math.min(
          duration,
          first.start + maxSeconds,
          Math.max(first.start + minSeconds, sentence?.end ?? first.end),
        ),
      );
    const text = cleanWord(first.text, preset);
    if (end - first.start < minSeconds - SLACK) {
      notes?.push({
        item: "big-word",
        action: "dropped",
        rule: "big-word-time",
        reason: `the big word ${quote(text)} is said too close to the end to show ${minSeconds} s`,
      });
      return null;
    }
    if (crossesHidden({ start: first.start, end })) {
      notes?.push({
        item: "big-word",
        action: "dropped",
        rule: "hidden-footage",
        reason: `the big word ${quote(text)} would show while the footage is hidden`,
      });
      return null;
    }
    return {
      ref: "big_word",
      kind: "big_word",
      id: "big-word",
      start: first.start,
      end,
      min: minSeconds,
      ...(choice.wish ? { wish: choice.wish } : {}),
      index: 0,
      word: first.id,
    };
  }

  function photoExtra(
    photo: PhotoChoice,
    index: number,
    id: string,
    notes: EngineNote[] | null,
  ): Extra | null {
    const ref = `photos[${index}]`;
    const shift = notes ? room.shift.get(ref) : undefined;
    const sentence = sentenceOf(photo.from)!;
    const at0 = sentences.indexOf(sentence);
    const lo = sentences[at0 - 1]?.end ?? 0;
    const hi = Math.min(duration, sentences[at0 + 1]?.start ?? duration);
    // From the sentence's start; in a long sentence whose photo words come
    // later, from its first word, so it still shows over its own words.
    const first = word(photo.from);
    let start = first.start - sentence.start > 1 ? first.start : sentence.start;
    let end = Math.min(start + maxSeconds, Math.max(sentence.end, start + minSeconds));
    if (end > hi + SLACK) {
      end = hi;
      start = Math.max(lo, hi - minSeconds);
    }
    if (shift?.word) {
      start = word(shift.word).start;
      end = shift.end;
    }
    start = ms(start);
    end = ms(end);
    if (end - start < minSeconds - SLACK) {
      notes?.push({
        item: id,
        action: "dropped",
        rule: "photo-time",
        reason: `photo ${index + 1}: its sentence and the pauses around it last under ${minSeconds} s`,
      });
      return null;
    }
    if (crossesHidden({ start, end })) {
      notes?.push({
        item: id,
        action: "dropped",
        rule: "hidden-footage",
        reason: `photo ${index + 1} would show while the footage is hidden`,
      });
      return null;
    }
    if (!shift && start < Math.min(sentence.start, first.start) - SLACK) {
      notes?.push({
        item: id,
        action: "retimed",
        rule: "photo-time",
        reason: `photo ${index + 1} starts at ${at(start)}, before its short sentence, to show ${minSeconds} s`,
      });
    }
    return {
      ref,
      kind: "photo",
      id,
      start,
      end,
      min: minSeconds,
      ...(photo.wish ? { wish: photo.wish } : {}),
      index,
      ...(shift?.word ? { startWord: shift.word } : {}),
      photo,
    };
  }

  const extras: Extra[] = [];
  let accentCount = 0;
  const accentIds = input.accents.map((accent) =>
    accent.title ? "title" : `accent-${++accentCount}`,
  );
  input.accents.forEach((accent, index) => {
    if (room.removed.has(`accents[${index}]`)) return;
    const extra = accentExtra(accent, index, accentIds[index]!, record);
    if (extra) extras.push(extra);
  });
  if (input.big_word && !room.removed.has("big_word")) {
    const extra = bigWordExtra(input.big_word, record);
    if (extra) extras.push(extra);
  }
  input.photos.forEach((photo, index) => {
    if (room.removed.has(`photos[${index}]`)) return;
    const extra = photoExtra(photo, index, `photo-${index + 1}`, record);
    if (extra) extras.push(extra);
  });

  // Placement words that only a transition takes (`slow`, `long`) asked of
  // another item: not kept.
  for (const [index, accent] of input.accents.entries()) {
    if (room.removed.has(`accents[${index}]`)) continue;
    if (accent.wish === "slow" || accent.wish === "long") {
      record.push({
        item: accentIds[index]!,
        action: "wish-not-kept",
        rule: "wish",
        reason: `${accent.title ? "the title" : "accent"} ${quote(wordsText(range(accent.from, accent.to), transcript, preset))} cannot move ${accent.wish === "slow" ? "slower" : "longer"}: only a transition can`,
      });
    }
  }
  for (const [index, photo] of input.photos.entries()) {
    if (room.removed.has(`photos[${index}]`)) continue;
    if (photo.wish === "slow" || photo.wish === "long") {
      record.push({
        item: `photo-${index + 1}`,
        action: "wish-not-kept",
        rule: "wish",
        reason: `photo ${index + 1} cannot move ${photo.wish === "slow" ? "slower" : "longer"}: only a transition can`,
      });
    }
  }
  if (
    input.big_word &&
    !room.removed.has("big_word") &&
    (input.big_word.wish === "slow" || input.big_word.wish === "long")
  ) {
    record.push({
      item: "big-word",
      action: "wish-not-kept",
      rule: "wish",
      reason: `the big word cannot move ${input.big_word.wish === "slow" ? "slower" : "longer"}: only a transition can`,
    });
  }

  // The scene: every edge of every item.
  const scene = sceneOf(
    [
      ...captions.map((_, index) => unitStart(index)),
      ...ends,
      ...transitionPlans.flatMap((plan) => [plan.start, plan.end]),
      ...extras.flatMap((extra) => [extra.start, extra.end]),
    ],
    duration,
    headTrack,
  );
  function unitStart(index: number): number {
    return resolveAnchor(captions[index]!.start, byId, duration);
  }
  const faceObstacles = (span: { start: number; end: number }) =>
    facesDuring(scene, span).map((face) => ({
      ...face,
      top: face.top - gap,
      bottom: face.bottom + gap,
    }));
  const shown: Shown[] = [];
  const textDuring = (span: { start: number; end: number }) =>
    shown.filter((item) => during(item, span)).map((item) => expand(item.box, gap));

  // Readability: the worst contrast of a text's colours over a box and span.
  const { backgrounds } = options;
  const { readability } = preset;
  type Threshold = { min: number; strongBelow: number };
  function contrastOf(
    sampler: Backgrounds,
    box: Box,
    span: { start: number; end: number },
    colors: readonly string[],
  ): number {
    let worst = Infinity;
    for (const color of colors) {
      const text = relativeLuminance(color);
      worst = Math.min(worst, contrastRatio(text, sampler.behind(box, span, text)));
    }
    return worst;
  }

  // The nearest free place in the same zone (the same area and obstacles,
  // the same size) within the preset's radius whose contrast reaches the
  // threshold. Wanted points: the original centre, then a grid every
  // `moveStep` pixels, row by row from the top, left to right; ties go to
  // the higher, then the further left place.
  function readablePlace(
    sampler: Backgrounds,
    area: Box,
    obstacles: readonly Box[],
    width: number,
    height: number,
    from: { x: number; y: number },
    span: { start: number; end: number },
    colors: readonly string[],
    threshold: Threshold,
    accept: (box: Box) => boolean = () => true,
  ): { x: number; y: number; ratio: number; distance: number } | null {
    const { moveRadius, moveStep } = readability;
    const cx = from.x + width / 2;
    const cy = from.y + height / 2;
    const wants = [{ x: cx, y: cy }];
    const steps = Math.floor(moveRadius / moveStep);
    for (let dy = -steps; dy <= steps; dy += 1) {
      for (let dx = -steps; dx <= steps; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        if (Math.hypot(dx, dy) * moveStep > moveRadius + SLACK) continue;
        wants.push({ x: cx + dx * moveStep, y: cy + dy * moveStep });
      }
    }
    const seen = new Set<string>();
    let best: { x: number; y: number; ratio: number; distance: number } | null = null;
    for (const want of wants) {
      const spot = placeBox(area, obstacles, width, height, want);
      if (!spot) continue;
      const key = `${spot.x},${spot.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const distance = Math.hypot(spot.x - from.x, spot.y - from.y);
      if (distance < 0.5 || distance > moveRadius + SLACK) continue;
      const box = { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + height };
      if (!accept(box)) continue;
      const ratio = contrastOf(sampler, box, span, colors);
      if (ratio < threshold.min) continue;
      if (
        !best ||
        distance < best.distance - 1e-9 ||
        (Math.abs(distance - best.distance) <= 1e-9 &&
          (spot.y < best.y || (spot.y === best.y && spot.x < best.x)))
      ) {
        best = { ...spot, ratio, distance };
      }
    }
    return best;
  }

  function shadowLevel(ratio: number, threshold: Threshold): 1 | 2 {
    return ratio < threshold.strongBelow ? 2 : 1;
  }

  // What a text placed at `from` does for contrast: stays (readable, or no
  // map), moves to a readable free place, or gets a shadow; noted.
  function keepReadable(
    item: string,
    label: string,
    box: { x: number; y: number; width: number; height: number },
    span: { start: number; end: number },
    colors: readonly string[],
    threshold: Threshold,
    zone: { area: Box; obstacles: readonly Box[]; accept?: (box: Box) => boolean } | null,
    why: string,
  ): { x: number; y: number; shadow?: 1 | 2 } {
    const from = { x: box.x, y: box.y };
    if (!backgrounds) return from;
    const placed = {
      left: box.x,
      right: box.x + box.width,
      top: box.y,
      bottom: box.y + box.height,
    };
    const ratio = contrastOf(backgrounds, placed, span, colors);
    if (ratio >= threshold.min) return from;
    const when = `from ${at(span.start)} to ${at(span.end)}`;
    const moved = zone
      ? readablePlace(
          backgrounds,
          zone.area,
          zone.obstacles,
          box.width,
          box.height,
          from,
          span,
          colors,
          threshold,
          zone.accept,
        )
      : null;
    if (moved) {
      record.push({
        item,
        action: "moved",
        rule: "contrast-spot",
        reason: `${label} moves ${Math.round(moved.distance)} px to a free place it reads on: contrast ${ratioText(ratio)} ${when}, under ${threshold.min}:1, now ${ratioText(moved.ratio)}`,
      });
      return { x: moved.x, y: moved.y };
    }
    const shadow = shadowLevel(ratio, threshold);
    record.push({
      item,
      action: "shadowed",
      rule: "contrast-shadow",
      reason: `${label} gets a soft shadow (level ${shadow}): contrast ${ratioText(ratio)} ${when}, ${why}`,
    });
    return { ...from, shadow };
  }

  // Transitions take the screen over: each kept one's text levels (its
  // number, its lead-in, its key phrase) are placed before any caption, in
  // free space inside its area, off the face where possible. One whose levels
  // fit nowhere is dropped, so its captions show as usual. The captions of a
  // kept one's phrase show only as its levels.
  const transitionItems = new Map<string, { index: number; item: TransitionItem }>();
  const hiddenUnits = new Set<number>();
  let numbered = 0;
  for (const plan of transitionPlans) {
    const number = plan.choice.kind === "numbered" ? numbered + 1 : undefined;
    const item = placeLevels(plan, number);
    if (!item) continue;
    if (number !== undefined) numbered = number;
    transitionItems.set(plan.id, { index: plan.index, item });
    const phrase = new Set(item.words);
    captions.forEach((caption, index) => {
      if (phrase.has(caption.words[0]!)) hiddenUnits.add(index);
    });
  }
  const keptPlans = transitionPlans.filter((plan) => transitionItems.has(plan.id));

  function placeLevels(plan: TransitionPlan, number: number | undefined): TransitionItem | null {
    const { choice, label } = plan;
    const kind = preset.transitions[choice.kind];
    const ids = range(choice.from, choice.to);
    const phrase = new Set(ids);
    const keyAt = order.get(choice.key_from)!;
    // The phrase's text, after the word fixes: each word as the caption
    // showing it (once per caption), a word no caption shows as itself. A
    // caption goes to the lead-in or the key phrase by its first word; one
    // starting before the phrase keeps its own place and is left out here.
    const captionOf = new Map<string, number>();
    captions.forEach((caption, index) => {
      for (const id of caption.words) if (!captionOf.has(id)) captionOf.set(id, index);
    });
    const parts: { at: number; text: string }[] = [];
    const used = new Set<number>();
    for (const id of ids) {
      const index = captionOf.get(id);
      if (index === undefined) {
        parts.push({
          at: order.get(id)!,
          text: fixes.get(id) ?? wordsText([id], transcript, preset),
        });
        continue;
      }
      if (used.has(index)) continue;
      used.add(index);
      const first = captions[index]!.words[0]!;
      if (!phrase.has(first)) continue;
      parts.push({ at: order.get(first)!, text: texts[index]! });
    }
    let leadParts = parts.filter((part) => part.at < keyAt);
    let keyParts = parts.filter((part) => part.at >= keyAt);
    if (keyParts.length === 0) {
      keyParts = leadParts.slice(-1);
      leadParts = leadParts.slice(0, -1);
    }
    const lead = leadParts.map((part) => part.text).join(" ");
    const key = keyParts.map((part) => part.text).join(" ");
    const specs = [
      ...(number !== undefined
        ? [{ role: "number" as const, text: String(number), start: plan.startAnchor }]
        : []),
      ...(lead ? [{ role: "lead" as const, text: lead, start: { word: choice.from } }] : []),
      { role: "key" as const, text: key, start: { word: choice.key_from } },
    ].map((spec) => ({ ...spec, ...levelStyle(spec.role, preset) }));
    if (!key || specs.some((spec) => spec.text.length > 300)) {
      record.push({
        item: plan.id,
        action: "dropped",
        rule: "no-room",
        reason: `${label} dropped: its phrase has no text to show inside it, or too much`,
      });
      return null;
    }
    const area = intersectBox(kind.area, safe);
    const cx = (area.left + area.right) / 2;
    const sizes = specs.map((spec) => sizesFrom(spec.size, preset));
    const steps = Math.max(...sizes.map((list) => list.length));
    // Wrapped in turn: the key phrase, then the lead-in (one word never).
    const wraps: LevelRole[][] = [[]];
    for (const role of ["key", "lead"] as const) {
      const spec = specs.find((entry) => entry.role === role);
      if (spec && spec.text.includes(" ")) wraps.push([...wraps.at(-1)!, role]);
    }
    const stackOf = (step: number, wrapped: readonly LevelRole[]) => {
      const levels = specs.map((spec, at) => {
        const list = sizes[at]!;
        const size = list[Math.min(step, list.length - 1)]!;
        const lines = wrapped.includes(spec.role)
          ? balancedBreak(spec.text.split(" "), spec.font, size)
          : [spec.text];
        const width = Math.max(...lines.map((line) => measurer.width(spec.font, size, line)));
        return { spec, size, lines, width, height: size * lines.length };
      });
      const gapY = preset.transition.gap;
      return {
        levels,
        width: Math.max(...levels.map((level) => level.width)),
        height: levels.reduce((sum, level) => sum + level.height, 0) + gapY * (levels.length - 1),
      };
    };
    let found: {
      stack: ReturnType<typeof stackOf>;
      spot: { x: number; y: number };
      step: number;
      wrapped: readonly LevelRole[];
      overFace: boolean;
    } | null = null;
    for (const overFace of [false, true]) {
      const obstacles = [...(overFace ? [] : faceObstacles(plan)), ...textDuring(plan), notch];
      for (let step = 0; step < steps && !found; step += 1) {
        for (const wrapped of wraps) {
          const stack = stackOf(step, wrapped);
          const spot = placeBox(area, obstacles, stack.width, stack.height, {
            x: cx,
            y: kind.want + stack.height / 2,
          });
          if (spot) {
            found = { stack, spot, step, wrapped, overFace };
            break;
          }
        }
      }
      if (found) break;
    }
    if (!found) {
      record.push({
        item: plan.id,
        action: "dropped",
        rule: "no-room",
        reason: `${label} dropped: its text found no place inside it from ${at(plan.start)} to ${at(plan.end)}, even at the smallest size`,
      });
      return null;
    }
    const { stack, spot, step, wrapped, overFace } = found;
    const first = placeBox(area, [], stack.width, stack.height, {
      x: cx,
      y: kind.want + stack.height / 2,
    });
    if (overFace) {
      record.push({
        item: plan.id,
        action: "covers-face",
        rule: "transition-face",
        reason: `the text of ${label} found no place clear of the face from ${at(plan.start)} to ${at(plan.end)} and sits over part of it`,
      });
    } else if (first && (first.x !== spot.x || first.y !== spot.y)) {
      record.push({
        item: plan.id,
        action: "moved",
        rule: "transition-spot",
        reason: `the text of ${label} moves ${Math.round(Math.hypot(spot.x - first.x, spot.y - first.y))} px from its first place, clear of the face and other text`,
      });
    }
    if (step > 0) {
      const sized = stack.levels
        .map((level) => `${level.spec.role} ${level.size} px instead of ${level.spec.size} px`)
        .join(", ");
      record.push({
        item: plan.id,
        action: "shrunk",
        rule: "transition-size",
        reason: `the text of ${label} set smaller to fit: ${sized}`,
      });
    }
    if (wrapped.length > 0) {
      record.push({
        item: plan.id,
        action: "wrapped",
        rule: "transition-wrap",
        reason: `the ${wrapped.map((role) => (role === "key" ? "key phrase" : "lead-in")).join(" and the ")} of ${label} set in two lines to fit`,
      });
    }
    const centre = Math.round((spot.x + stack.width / 2) * 100) / 100;
    const levels: Partial<Record<LevelRole, TransitionLevel>> = {};
    let y = spot.y;
    for (const level of stack.levels) {
      const left = centre - level.width / 2;
      levels[level.spec.role] = {
        text: level.spec.text,
        start: level.spec.start,
        position: { x: centre, y, align: "center" },
        size: level.size,
        ...(level.lines.length > 1 ? { break_after: level.lines[0]!.split(" ").length } : {}),
      };
      shown.push({
        id: `${plan.id}-${level.spec.role}`,
        start: Math.max(plan.start, resolveAnchor(level.spec.start, byId, duration)),
        end: plan.end,
        box: { left, right: left + level.width, top: y, bottom: y + level.height },
      });
      y += level.height + preset.transition.gap;
    }
    return {
      id: plan.id,
      type: choice.kind,
      start: plan.startAnchor,
      end: plan.endAnchor,
      words: ids,
      key: choice.key_from,
      ...(plan.wish === "slow" ? { pace: "slow" as const } : {}),
      ...(plan.wish === "long" ? { hold: "long" as const } : {}),
      ...(number !== undefined ? { number } : {}),
      levels: { ...levels, key: levels.key! },
    };
  }

  // Captions: blocks in time order, each a sentence's groups (one spot for the
  // whole sentence); a transition's own captions show only as its levels.
  const blocks: CaptionBlock[] = [];
  const sentenceBlocks = new Map<SentenceSpan | undefined, CaptionBlock>();
  groups.forEach((group, index) => {
    const end = ends[index]!;
    const outside = group.filter((unit) => !hiddenUnits.has(unit.index));
    if (outside.length === 0) return;
    const sentence = sentenceOf(outside[0]!.caption.words[0]!);
    let block = sentenceBlocks.get(sentence);
    if (!block) {
      block = { groups: [], start: outside[0]!.start, end };
      sentenceBlocks.set(sentence, block);
      blocks.push(block);
    }
    block.groups.push(outside);
    block.end = Math.max(block.end, end);
  });
  blocks.sort((a, b) => a.start - b.start);

  const captionFont = preset.caption.font;
  const placedCaptions = new Map<number, { x: number; y: number; size: number; shadow?: 1 | 2 }>();
  const photoSpans = extras.filter((extra) => extra.kind === "photo");

  // The extras by priority, at most one at a time.
  const rank = (extra: Extra) => {
    const asked = requested.indexOf(extra.ref);
    const kind = { transition: 0, accent: 1, big_word: 2, photo: 3 }[extra.kind];
    return asked >= 0 ? asked - 1000 : kind * 100;
  };
  const queue = extras
    .map((extra, index) => ({ extra, index }))
    .sort((a, b) => rank(a.extra) - rank(b.extra) || a.index - b.index)
    .map(({ extra }) => extra);
  // A running transition is an extra the one-at-a-time rule never trims.
  const accepted: Accepted[] = keptPlans.map((plan) => ({
    extra: {
      ref: plan.ref,
      kind: "transition",
      id: plan.id,
      start: plan.start,
      end: plan.end,
      min: plan.end - plan.start,
      index: plan.index,
    },
    start: plan.start,
    end: plan.end,
  }));
  const overlays = new Map<string, OverlayItem>();
  const behind = new Map<string, BehindItem>();
  const blockPlaces = new Map<string, BlockPlace>();
  const facesCovered = new Set<string>();

  // Making room: the reserved requested items first, before any caption;
  // the captions sharing their time keep clear of them (a photo's spot is
  // an obstacle to them).
  const reservations: { mode: "move" | "shrink"; start: number; end: number; box?: Box }[] = [];
  const preplaced = new Set<string>();
  for (const extra of queue) {
    const mode = room.reserve.get(extra.ref);
    if (!mode) continue;
    const notes = record.length;
    if (!tryExtra(extra)) {
      record.length = notes;
      continue;
    }
    preplaced.add(extra.ref);
    const span = accepted.at(-1)!;
    const photo = behind.get(extra.id);
    reservations.push({
      mode,
      start: span.start,
      end: span.end,
      ...(photo?.kind === "photo" ? { box: spotBox(photo.spot, preset) } : {}),
    });
  }
  const reservedDuring = (span: { start: number; end: number }) =>
    reservations.filter((reservation) => during(reservation, span));

  for (const block of blocks) {
    placeBlock(block);
  }
  for (const extra of queue) {
    if (!preplaced.has(extra.ref)) tryExtra(extra);
  }

  function captionCandidates(block: CaptionBlock): Candidate[] {
    const faces = facesDuring(scene, block);
    const face = boundingBox(faces);
    const out: Candidate[] = [];
    const maxLines = 2;
    const line: Candidate = {
      name: "on the caption line",
      area: { ...safe, top: preset.caption.fallbackY },
      align: "center",
      want: (w, h) => ({ x: safeCx, y: preset.caption.fallbackY + h / 2 }),
      maxLines,
    };
    if (face) {
      const top = Math.max(safe.top, face.top);
      const bottom = Math.min(safe.bottom, face.bottom + 120);
      const mouth = face.top + 0.7 * (face.bottom - face.top);
      const left: Candidate = {
        name: "beside the head on the left",
        area: { left: safe.left, right: face.left, top, bottom },
        align: "right",
        want: (w) => ({ x: face.left - w / 2, y: mouth }),
        maxLines,
      };
      const right: Candidate = {
        name: "beside the head on the right",
        area: { left: face.right, right: safe.right, top, bottom },
        align: "left",
        want: (w) => ({ x: face.right + w / 2, y: mouth }),
        maxLines,
      };
      const sides = safe.right - face.right > face.left - safe.left ? [right, left] : [left, right];
      out.push(...sides, {
        name: "below the face",
        area: { ...safe, top: face.bottom + gap },
        align: "center",
        want: (w, h) => ({
          x: Math.min(
            safe.right - w / 2,
            Math.max(safe.left + w / 2, (face.left + face.right) / 2),
          ),
          y: face.bottom + gap + h / 2,
        }),
        maxLines,
      });
      out.push(line);
    } else {
      out.push(line, {
        name: "in the safe zone",
        area: safe,
        align: "center",
        want: (w, h) => ({ x: safeCx, y: preset.caption.fallbackY + h / 2 }),
        maxLines,
      });
    }
    return out;
  }

  // Whether a caption box over a block leaves a photo of the same moment a spot.
  function leavesPhotoSpot(box: Box, span: { start: number; end: number }): boolean {
    const photos = photoSpans.filter((photo) => during(photo, span));
    return photos.every((photo) =>
      BEHIND_SPOTS.some(
        (spot) =>
          !overlaps(box, spotBox(spot, preset)) && spotClearOfFace(spot, photo, preset, headTrack),
      ),
    );
  }

  function tryBlock(
    block: CaptionBlock,
    candidate: Candidate,
    size: number,
    keepPhotoSpot: boolean,
  ): { x: number; y: number; width: number; height: number; layouts: Line[][] } | null {
    const areaWidth = candidate.area.right - candidate.area.left;
    if (areaWidth <= 0) return null;
    const layouts: Line[][] = [];
    let width = 0;
    let height = 0;
    for (const group of block.groups) {
      const lines = wrapUnits(group, captionFont, size, areaWidth, candidate.maxLines, measurer);
      if (!lines) return null;
      layouts.push(lines);
      width = Math.max(width, ...lines.map((line) => line.width));
      height = Math.max(height, lines.length * size + (lines.length - 1) * preset.caption.lineGap);
    }
    const spot = placeBox(
      candidate.area,
      blockObstacles(block, candidate),
      width,
      height,
      candidate.want(width, height),
    );
    if (!spot) return null;
    const box = { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + height };
    if (keepPhotoSpot && !leavesPhotoSpot(box, block)) return null;
    return { ...spot, width, height, layouts };
  }

  // What a caption block keeps clear of: the face (unless it is the worst
  // case over it), the text shown with it and the notch.
  function blockObstacles(block: CaptionBlock, candidate: Candidate): Box[] {
    return [
      ...(candidate.overFace ? [] : faceObstacles(block)),
      ...textDuring(block),
      notch,
      ...reservedDuring(block).flatMap((reservation) =>
        reservation.box ? [expand(reservation.box, gap)] : [],
      ),
    ];
  }

  function placeBlock(block: CaptionBlock): void {
    const candidates = captionCandidates(block);
    const sizes = sizesFrom(preset.fonts[captionFont].size, preset);
    const first = block.groups[0]![0]!;
    const label = block.groups
      .flat()
      .map((unit) => unit.text)
      .join(" ");
    let chosen: {
      candidate: Candidate;
      size: number;
      fit: NonNullable<ReturnType<typeof tryBlock>>;
      keep: boolean;
    } | null = null;
    const holdsPhoto = photoSpans.some((photo) => during(photo, block));
    // Sharing time with a reserved item: at the full size only (`move`) or
    // down to the floor (`shrink`), and never over the face for it.
    const reserved = reservedDuring(block);
    const tried = reserved.some((reservation) => reservation.mode === "move")
      ? sizes.slice(0, 1)
      : sizes;
    // Captions stay readable first: every place at the full size before any
    // smaller size.
    for (const keep of holdsPhoto ? [true, false] : [false]) {
      for (const size of tried) {
        for (const candidate of candidates) {
          const fit = tryBlock(block, candidate, size, keep);
          if (fit) {
            chosen = { candidate, size, fit, keep };
            break;
          }
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    if (!chosen && reserved.length > 0 && !room.overFace.has(first.caption.id)) failed = true;
    if (!chosen) {
      const floor = sizes.at(-1)!;
      for (const area of [{ ...safe, top: preset.caption.fallbackY }, safe]) {
        const worst: Candidate = {
          name: "on the caption line over the face",
          area,
          align: "center",
          want: (w, h) => ({ x: safeCx, y: area.top + h / 2 }),
          maxLines: 20,
          overFace: true,
        };
        const fit = tryBlock(block, worst, floor, false);
        if (fit) {
          chosen = { candidate: worst, size: floor, fit, keep: false };
          break;
        }
      }
      if (!chosen) {
        // Larger than the safe zone at the floor: one unit per line from its
        // top (never reached at the preset's sizes).
        const layouts = block.groups.map((group) =>
          group.map((unit) => {
            const w = measurer.width(captionFont, floor, unit.text);
            return { units: [{ unit, width: w }], width: w };
          }),
        );
        chosen = {
          candidate: {
            name: "at the top of the safe zone over everything",
            area: safe,
            align: "left",
            want: () => ({ x: safe.left, y: safe.top }),
            maxLines: 99,
            overFace: true,
          },
          size: floor,
          fit: {
            x: safe.left,
            y: safe.top,
            width: safe.right - safe.left,
            height: Math.max(
              ...layouts.map(
                (lines) => lines.length * floor + (lines.length - 1) * preset.caption.lineGap,
              ),
            ),
            layouts,
          },
          keep: false,
        };
      }
      facesCovered.add(first.caption.id);
      record.push({
        item: first.caption.id,
        action: "covers-face",
        rule: "caption-face",
        reason: `captions ${quote(label)} (${at(block.start)} to ${at(block.end)}) found no free place and sit ${chosen.candidate.name}`,
      });
    } else if (chosen.candidate !== candidates[0]) {
      record.push({
        item: first.caption.id,
        action: "moved",
        rule: "caption-spot",
        reason: `captions ${quote(label)} (${at(block.start)} to ${at(block.end)}) sit ${chosen.candidate.name}: no room ${candidates[0]!.name}`,
      });
    }
    const { candidate, size, fit, keep } = chosen;
    blockPlaces.set(first.caption.id, {
      label,
      start: block.start,
      end: block.end,
      name: candidate.name,
      size,
      x: fit.x,
      y: fit.y,
    });
    const fullSize = preset.fonts[captionFont].size;
    if (size < fullSize) {
      record.push({
        item: first.caption.id,
        action: "shrunk",
        rule: "caption-size",
        reason: `captions ${quote(label)} set at ${size} px instead of ${fullSize} px to fit`,
      });
    }
    // Readable over the footage; captions over the face are only ever
    // shadowed.
    const place = keepReadable(
      first.caption.id,
      `captions ${quote(label)}`,
      fit,
      block,
      [...new Set(block.groups.flat().map((unit) => unit.caption.color ?? preset.caption.color))],
      readability.caption,
      candidate.overFace
        ? null
        : {
            area: candidate.area,
            obstacles: blockObstacles(block, candidate),
            ...(keep ? { accept: (box: Box) => leavesPhotoSpot(box, block) } : {}),
          },
      candidate.overFace
        ? "captions over the face are never moved"
        : `no free place nearby reaches ${readability.caption.min}:1`,
    );
    const space = measurer.width(captionFont, size, " ");
    for (const lines of fit.layouts) {
      let y = place.y;
      for (const line of lines) {
        let x =
          candidate.align === "left"
            ? place.x
            : candidate.align === "right"
              ? place.x + fit.width - line.width
              : place.x + (fit.width - line.width) / 2;
        for (const { unit, width } of line.units) {
          const left = Math.floor(x * 100) / 100;
          placedCaptions.set(unit.index, {
            x: left,
            y,
            size,
            ...(place.shadow ? { shadow: place.shadow } : {}),
          });
          shown.push({
            id: unit.caption.id,
            start: unit.start,
            end: unitEnd.get(unit.index)!,
            box: { left, right: left + width, top: y, bottom: y + size },
          });
          x += width + space;
        }
        y += size + preset.caption.lineGap;
      }
    }
  }

  // One extra by the one-at-a-time rule, then placed; true when placed.
  function tryExtra(extra: Extra): boolean {
    const timed = fitTime(extra, accepted);
    if (!timed.ok) {
      const other = timed.with;
      record.push({
        item: extra.id,
        action: "dropped",
        rule: "one-extra",
        reason:
          other.extra.kind !== "transition"
            ? `${describe(extra)} would show at the same time as ${describe(other.extra)} (${at(extra.start)} to ${at(extra.end)}); one extra at a time`
            : other.start <= extra.start + SLACK
              ? `${describe(extra)} would show (${at(extra.start)} to ${at(extra.end)}) while a transition is running from ${at(other.start)} to ${at(other.end)}; nothing else shows during a transition`
              : `${describe(extra)} would show (${at(extra.start)} to ${at(extra.end)}) but a transition comes in at ${at(other.start)}, too soon for it to show ${extra.min} s; nothing else shows during a transition`,
      });
      return false;
    }
    const span = { start: extra.start, end: timed.end };
    // The earlier extras it cuts short leave before it comes in, so they are
    // no obstacle; put back when it is not placed.
    const cut = timed.trims.map((trim) => ({
      trim,
      item: shown.find((item) => item.id === trim.accepted.extra.id),
    }));
    const kept = cut.map(({ item }) => item?.end);
    for (const { trim, item } of cut) if (item) item.end = trim.end;
    const placed =
      extra.kind === "accent"
        ? placeAccent(extra, span)
        : extra.kind === "big_word"
          ? placeBigWord(extra, span)
          : placePhoto(extra, span);
    if (!placed) {
      cut.forEach(({ item }, index) => {
        if (item) item.end = kept[index]!;
      });
      return false;
    }
    for (const trim of timed.trims) {
      trim.accepted.end = trim.end;
      record.push({
        item: trim.accepted.extra.id,
        action: "retimed",
        rule: "one-extra",
        reason: `${describe(trim.accepted.extra)} leaves at ${at(trim.end)}, when ${describe(extra)} needs the space`,
      });
    }
    if (timed.end < extra.end - SLACK) {
      record.push({
        item: extra.id,
        action: "retimed",
        rule: "one-extra",
        reason: `${describe(extra)} leaves at ${at(timed.end)}, before ${describe(timed.before!.extra)} comes in`,
      });
    }
    accepted.push({ extra, start: span.start, end: span.end });
    return true;
  }

  function describe(extra: Extra): string {
    if (extra.kind === "transition") return `transition ${extra.index + 1}`;
    if (extra.kind === "accent") {
      const accent = extra.accent!;
      return `${accent.title ? "the title" : "accent"} ${quote(accentText(accent))}`;
    }
    if (extra.kind === "big_word") {
      return `the big word ${quote(cleanWord(word(extra.word!).text, preset))}`;
    }
    return `photo ${extra.index + 1}`;
  }

  function accentText(accent: AccentChoice): string {
    return wordsText(range(accent.from, accent.to), transcript, preset);
  }

  function placeAccent(extra: Extra, span: { start: number; end: number }): boolean {
    const accent = extra.accent!;
    const ids = range(accent.from, accent.to);
    const text = wordsText(ids, transcript, preset);
    const font = preset.accent.font;
    const fullSize = preset.fonts[font].size;
    const faces = facesDuring(scene, span);
    const face = boundingBox(faces);
    const bodies = faces.map((f) => {
      const width = f.right - f.left;
      return {
        left: f.left - width * 0.4,
        right: f.right + width * 0.4,
        top: f.bottom,
        bottom: preset.frame.height,
      };
    });
    const mid = (safe.top + safe.bottom) / 2;
    const areas: Record<string, Candidate> = {
      above: {
        name: "above the head",
        area: { ...safe, bottom: face ? face.top - gap : safe.top },
        align: "center",
        want: (w, h) => ({
          x: safeCx,
          y: face ? Math.max(safe.top + h / 2, face.top - preset.accent.aboveHead + h / 2) : 0,
        }),
        maxLines: 2,
      },
      top: {
        name: "in the upper part of the frame",
        area: { ...safe, bottom: mid },
        align: "center",
        want: (w, h) => ({ x: safeCx, y: safe.top + h / 2 }),
        maxLines: 2,
      },
      bottom: {
        name: "in the lower part of the frame",
        area: { ...safe, top: mid },
        align: "center",
        want: (w, h) => ({ x: safeCx, y: safe.bottom - h / 2 }),
        maxLines: 2,
      },
      left: {
        name: "on the left",
        area: { ...safe, right: safeCx },
        align: "center",
        want: (w) => ({ x: safe.left + w / 2, y: mid }),
        maxLines: 2,
      },
      right: {
        name: "on the right",
        area: { ...safe, left: safeCx },
        align: "center",
        want: (w) => ({ x: safe.right - w / 2, y: mid }),
        maxLines: 2,
      },
      line: {
        name: "on the accent line",
        area: safe,
        align: "center",
        want: (w, h) => ({ x: safeCx, y: preset.accent.noHeadY + h / 2 }),
        maxLines: 2,
      },
      anywhere: {
        name: "in the free part of the safe zone",
        area: safe,
        align: "center",
        want: (w, h) => ({ x: safeCx, y: face ? face.top - h : mid }),
        maxLines: 2,
      },
    };
    if (face) {
      areas.beside_head = {
        name: "beside the head",
        area: {
          ...safe,
          top: Math.max(safe.top, face.top),
          bottom: Math.min(safe.bottom, face.bottom),
        },
        align: "center",
        want: (w, h) => ({ x: face.left - w / 2, y: face.top + h / 2 }),
        maxLines: 2,
      };
    }
    const base = face ? ["above", "top", "anywhere"] : ["line", "anywhere"];
    const wished = extra.wish && areas[extra.wish] ? [extra.wish] : [];
    const names = [...new Set([...wished, ...base])];
    const candidates = names.map((name) => areas[name]!);
    // A requested accent allowed over the face keeps clear of text only.
    const obstacles = [
      ...(room.faceOk.has(extra.ref) ? [] : [...faceObstacles(span), ...bodies]),
      ...textDuring(span),
      notch,
    ];
    const words = text.split(" ");
    const sizes = sizesFrom(fullSize, preset).filter(
      (size) => extra.wish !== "small" || size <= Math.round(fullSize * 0.8),
    );
    for (const candidate of candidates) {
      for (const size of sizes) {
        for (const lineCount of words.length > 1 ? [1, 2] : [1]) {
          const lines = lineCount === 1 ? [text] : balancedBreak(words, font, size);
          const widths = lines.map((line) => measurer.width(font, size, line));
          const width = Math.max(...widths);
          const height = lines.length * size;
          const spot = placeBox(
            candidate.area,
            obstacles,
            width,
            height,
            candidate.want(width, height),
          );
          if (!spot) continue;
          const label = `${accent.title ? "the title" : "accent"} ${quote(text)}`;
          // Measured once its place and size are known; the notes on the
          // place itself come first.
          const notes = record.length;
          const place = keepReadable(
            extra.id,
            label,
            { ...spot, width, height },
            span,
            [preset.accent.color],
            readability.large,
            { area: candidate.area, obstacles },
            `no free place nearby reaches ${readability.large.min}:1`,
          );
          const contrastNotes = record.splice(notes);
          const item: OverlayItem = {
            id: extra.id,
            kind: "accent",
            start: { word: extra.startWord ?? accent.from },
            end: { word: accent.to, edge: "end" },
            words: ids,
            position: { x: place.x, y: place.y, align: "left" },
            size,
            ...(lines.length > 1 ? { break_after: lines[0]!.split(" ").length } : {}),
            ...(place.shadow ? { shadow: place.shadow } : {}),
          };
          overlays.set(extra.id, item);
          shown.push({
            id: extra.id,
            start: span.start,
            end: span.end,
            box: { left: place.x, right: place.x + width, top: place.y, bottom: place.y + height },
          });
          if (candidate !== candidates[0]) {
            record.push({
              item: extra.id,
              action: "moved",
              rule: "accent-spot",
              reason: `${label} sits ${candidate.name}: no room ${candidates[0]!.name}`,
            });
          }
          if (wished.length > 0 && candidate !== candidates[0]) {
            record.push({
              item: extra.id,
              action: "wish-not-kept",
              rule: "wish",
              reason: `${label} could not go ${candidates[0]!.name} as asked`,
            });
          }
          if (size < fullSize) {
            record.push({
              item: extra.id,
              action: "shrunk",
              rule: "accent-size",
              reason: `${label} set at ${size} px instead of ${fullSize} px to fit`,
            });
          }
          if (lines.length > 1) {
            record.push({
              item: extra.id,
              action: "wrapped",
              rule: "accent-wrap",
              reason: `${label} set in two lines to fit the frame`,
            });
          }
          record.push(...contrastNotes);
          return true;
        }
      }
    }
    record.push({
      item: extra.id,
      action: "dropped",
      rule: "no-room",
      reason: `${accent.title ? "the title" : "accent"} ${quote(text)} found no free place from ${at(span.start)} to ${at(span.end)}, even at ${sizes.at(-1)} px in two lines`,
    });
    return false;
  }

  function balancedBreak(words: readonly string[], font: FontKey, size: number): string[] {
    let best: string[] = [words.join(" ")];
    let widest = Infinity;
    for (let cut = 1; cut < words.length; cut += 1) {
      const lines = [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
      const width = Math.max(...lines.map((line) => measurer.width(font, size, line)));
      if (width < widest - SLACK) {
        widest = width;
        best = lines;
      }
    }
    return best;
  }

  function placeBigWord(extra: Extra, span: { start: number; end: number }): boolean {
    const first = word(extra.word!);
    const text = cleanWord(first.text, preset);
    const spec = preset.behind.word;
    const { width: frameWidth, height: frameHeight } = preset.frame;
    const perPx = measurer.width(spec.font, 1, text);
    const fit = perPx > 0 ? Math.floor((frameWidth - 2 * spec.margin) / perPx) : spec.maxSize;
    const largest = Math.max(8, Math.min(spec.maxSize, fit));
    const sizes = sizesFrom(largest, preset).filter(
      (size) => size >= 8 && (extra.wish !== "small" || size <= Math.round(largest * 0.8)),
    );
    const face = facesOver(headTrack, span.start, span.start)[0] ?? null;
    const centre = face ? face.top + spec.belowHeadTop : spec.noHeadY;
    const area = {
      left: spec.margin,
      right: frameWidth - spec.margin,
      top: spec.margin,
      bottom: frameHeight - spec.margin,
    };
    const obstacles = textDuring(span);
    for (const size of sizes) {
      const width = perPx * size;
      const spot = placeBox(area, obstacles, width, size, { x: frameWidth / 2, y: centre });
      if (!spot) continue;
      const notes = record.length;
      // The head overlapping it is the design: never moved, only shadowed.
      const { shadow } = keepReadable(
        extra.id,
        `the big word ${quote(text)}`,
        { ...spot, width, height: size },
        span,
        [spec.color],
        readability.large,
        null,
        "the big word is never moved",
      );
      const contrastNotes = record.splice(notes);
      behind.set(extra.id, {
        id: extra.id,
        kind: "word",
        text,
        start: { word: first.id },
        end: anchorAt(
          span.end,
          transcript.words.filter((w) => w.start >= first.start),
        ),
        position: spot,
        size,
        ...(shadow ? { shadow } : {}),
      });
      shown.push({
        id: extra.id,
        start: span.start,
        end: span.end,
        box: { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + size },
      });
      if (size < largest) {
        record.push({
          item: extra.id,
          action: "shrunk",
          rule: "big-word-size",
          reason: `the big word ${quote(text)} set at ${size} px instead of ${largest} px, clear of the captions`,
        });
      }
      record.push(...contrastNotes);
      return true;
    }
    record.push({
      item: extra.id,
      action: "dropped",
      rule: "no-room",
      reason: `the big word ${quote(text)} found no place clear of the captions from ${at(span.start)} to ${at(span.end)}`,
    });
    return false;
  }

  function placePhoto(extra: Extra, span: { start: number; end: number }): boolean {
    const index = extra.index;
    const photo = extra.photo!;
    const kept = (current.tracks.behind ?? []).find(
      (item) => item.kind === "photo" && item.photo_id === photo.photo_id,
    );
    const wished = BEHIND_SPOTS.find((spot) => spot === photo.wish);
    const pinned = room.spot.get(extra.ref);
    const order: BehindSpot[] = pinned
      ? [pinned]
      : [
          ...new Set([
            ...(wished ? [wished] : []),
            ...(kept?.kind === "photo" ? [kept.spot] : []),
            ...BEHIND_SPOTS,
          ]),
        ];
    const text = shown.filter((item) => during(item, span));
    const free = order.find(
      (spot) =>
        (room.faceOk.has(extra.ref) || spotClearOfFace(spot, span, preset, headTrack)) &&
        !text.some((item) => overlaps(item.box, spotBox(spot, preset))),
    );
    const label = `photo ${index + 1}`;
    if (!free) {
      record.push({
        item: extra.id,
        action: "dropped",
        rule: "no-room",
        reason: `${label}: every photo spot is under captions or the face from ${at(span.start)} to ${at(span.end)}`,
      });
      return false;
    }
    const sentence = sentenceOf(photo.from)!;
    behind.set(extra.id, {
      id: extra.id,
      kind: "photo",
      photo_id: photo.photo_id,
      spot: free,
      start: extra.startWord
        ? { word: extra.startWord }
        : Math.abs(span.start - sentence.start) < 0.0005
          ? { word: sentence.from }
          : Math.abs(span.start - word(photo.from).start) < 0.0005
            ? { word: photo.from }
            : anchorAt(span.start, transcript.words),
      end: anchorAt(span.end, transcript.words),
    });
    if (free !== order[0]) {
      record.push({
        item: extra.id,
        action: wished ? "wish-not-kept" : "moved",
        rule: wished ? "wish" : "photo-spot",
        reason: `${label} sits in the ${free} spot: the ${order[0]} spot is under captions or the face`,
      });
    }
    return true;
  }

  // An extra's end held clear of every accepted extra: an earlier one may be
  // cut short for it down to its own minimum; it may itself end before a later
  // one, down to its minimum; else it waits for nothing and is dropped.
  function fitTime(
    extra: Extra,
    taken: readonly Accepted[],
  ):
    | { ok: true; end: number; trims: { accepted: Accepted; end: number }[]; before?: Accepted }
    | { ok: false; with: Accepted } {
    let end = extra.end;
    let before: Accepted | undefined;
    const trims: { accepted: Accepted; end: number }[] = [];
    for (const other of [...taken].sort((a, b) => a.start - b.start)) {
      if (!during({ start: extra.start, end }, other)) continue;
      if (other.start < extra.start - SLACK) {
        // A running transition is never cut short.
        if (other.extra.kind === "transition") return { ok: false, with: other };
        if (extra.start - other.start < other.extra.min - SLACK) return { ok: false, with: other };
        trims.push({ accepted: other, end: extra.start });
      } else {
        if (other.start - extra.start < extra.min - SLACK) return { ok: false, with: other };
        end = other.start;
        before = other;
      }
    }
    return { ok: true, end, trims, ...(before ? { before } : {}) };
  }

  // The tracks, in the current version's caption order and the answer's order.
  // A caption a transition shows as its levels has no place of its own.
  const outCaptions: CaptionItem[] = captions.map((caption, index) => {
    const lastWord = unitEndWord.get(index)!;
    const end = unitEnd.get(index)!;
    const offset = ms(end - lastWord.end);
    const endAnchor: Anchor =
      offset === 0
        ? { word: lastWord.id, edge: "end" }
        : { word: lastWord.id, edge: "end", offset };
    const place = placedCaptions.get(index);
    if (!place) return { ...caption, end: endAnchor };
    return {
      ...caption,
      end: endAnchor,
      position: { x: place.x, y: place.y, align: "left" },
      size: place.size,
      ...(place.shadow ? { shadow: place.shadow } : {}),
    };
  });
  const outOverlays: OverlayItem[] = [];
  for (const id of accentIds) {
    const item = overlays.get(id);
    if (!item) continue;
    const span = accepted.find((entry) => entry.extra.id === id)!;
    const from = byId.get((item.start as { word: string }).word)!;
    outOverlays.push({
      ...item,
      end: anchorAt(
        span.end,
        transcript.words.filter((w) => w.start >= from.start),
      ),
    });
  }
  const outBehind: BehindItem[] = [];
  for (const extra of extras) {
    if (extra.kind === "accent") continue;
    const item = behind.get(extra.id);
    if (!item) continue;
    const span = accepted.find((entry) => entry.extra.id === extra.id)!;
    const start = resolveAnchor(item.start, byId, duration);
    outBehind.push({
      ...item,
      end: anchorAt(
        span.end,
        transcript.words.filter((w) => w.start >= start),
      ),
    });
  }
  // Photos before the big word, as the answer lists them.
  outBehind.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "photo" ? -1 : 1));

  // What the pass left out, by answer item, with its drop as a code.
  const placed = new Set([
    ...extras.filter((extra) => overlays.has(extra.id) || behind.has(extra.id)).map((e) => e.ref),
    ...keptPlans.map((plan) => plan.ref),
  ]);
  const WHY: Record<string, UnplacedWhy> = {
    "no-room": "no-room",
    "one-extra": "busy",
    "accent-time": "too-short",
    "big-word-time": "too-short",
    "photo-time": "too-short",
    "hidden-footage": "hidden",
  };
  const whyOf = (ref: string, id: string): UnplacedWhy => {
    if (room.removed.has(ref)) return "busy";
    const note = record.findLast((entry) => entry.item === id && entry.action === "dropped");
    return (note && WHY[note.rule]) ?? "no-room";
  };
  const items: Omit<UnplacedItem, "requested" | "why">[] = [
    ...input.accents.map((accent, index) => ({
      ref: `accents[${index}]`,
      id: accentIds[index]!,
      kind: "accent" as const,
      from: accent.from,
      to: accent.to,
    })),
    ...(input.big_word
      ? [
          {
            ref: "big_word",
            id: "big-word",
            kind: "big_word" as const,
            from: input.big_word.word,
            to: input.big_word.word,
          },
        ]
      : []),
    ...input.photos.map((photo, index) => ({
      ref: `photos[${index}]`,
      id: `photo-${index + 1}`,
      kind: "photo" as const,
      from: photo.from,
      to: photo.to,
      photo_id: photo.photo_id,
    })),
  ];
  const unplaced: UnplacedItem[] = items
    .filter((item) => !placed.has(item.ref))
    .map((item) => ({
      ...item,
      requested: requested.includes(item.ref),
      why: whyOf(item.ref, item.id),
    }));

  // Whether an extra would fit now, committing nothing: everything it
  // touches is put back.
  function probe(extra: Extra | null): boolean {
    if (!extra) return false;
    const notes = record.length;
    const shownEnds = shown.map((item) => item.end);
    const shownCount = shown.length;
    const acceptedEnds = accepted.map((entry) => entry.end);
    const acceptedCount = accepted.length;
    const fits = tryExtra({ ...extra, id: PROBE });
    record.length = notes;
    shown.length = shownCount;
    shown.forEach((item, index) => (item.end = shownEnds[index]!));
    accepted.length = acceptedCount;
    accepted.forEach((entry, index) => (entry.end = acceptedEnds[index]!));
    overlays.delete(PROBE);
    behind.delete(PROBE);
    return fits;
  }

  // Sentences with room for the kinds left out: a photo over the whole
  // sentence, an accent on its first words (up to three), the big word on
  // its longest plain word.
  function free(): FreeSentence[] {
    const kinds = new Set(unplaced.map((item) => item.kind));
    if (kinds.size === 0) return [];
    const photoId = unplaced.find((item) => item.kind === "photo")?.photo_id;
    const out: FreeSentence[] = [];
    for (const sentence of sentences) {
      const ids = range(sentence.from, sentence.to);
      const roomFor: ExtraKind[] = [];
      if (
        kinds.has("accent") &&
        probe(
          accentExtra(
            { from: sentence.from, to: ids[Math.min(2, ids.length - 1)]!, title: false },
            -1,
            PROBE,
            null,
          ),
        )
      ) {
        roomFor.push("accent");
      }
      if (
        kinds.has("photo") &&
        photoId !== undefined &&
        probe(
          photoExtra({ photo_id: photoId, from: sentence.from, to: sentence.to }, -1, PROBE, null),
        )
      ) {
        roomFor.push("photo");
      }
      if (kinds.has("big_word")) {
        let longest: string | null = null;
        for (const id of ids) {
          const text = cleanWord(word(id).text, preset);
          if (!BEHIND_WORD.test(text) || !/^\p{L}+$/u.test(text)) continue;
          if (!longest || text.length > cleanWord(word(longest).text, preset).length) longest = id;
        }
        if (longest && probe(bigWordExtra({ word: longest }, null))) roomFor.push("big_word");
      }
      if (roomFor.length > 0) out.push({ from: sentence.from, to: sentence.to, room_for: roomFor });
    }
    return out;
  }

  return {
    tracks: {
      footage: current.tracks.footage,
      captions: outCaptions,
      overlays: outOverlays,
      transitions: [...transitionItems.values()]
        .sort((a, b) => a.index - b.index)
        .map(({ item }) => item),
      sounds: current.tracks.sounds,
      ...(outBehind.length > 0 ? { behind: outBehind } : {}),
    },
    record,
    unplaced,
    free,
    placed,
    extras: new Map(extras.map((extra) => [extra.ref, extra])),
    labels: new Map(extras.map((extra) => [extra.ref, describe(extra)])),
    transitions: keptPlans.map((plan) => ({
      ref: plan.ref,
      label: `transition ${plan.index + 1} (${plan.choice.kind})`,
      start: plan.start,
      end: plan.end,
    })),
    blocks: blockPlaces,
    facesCovered,
    failed,
  };
}

// The id a probe places under, never an item's.
const PROBE = "probe";

// Whether the face leaves a photo spot clear (within the preset's share) at
// every moment of a span: the same faces the `behind-face` check reads.
function spotClearOfFace(
  spot: BehindSpot,
  span: { start: number; end: number },
  preset: Preset,
  headTrack: HeadTrack,
): boolean {
  return facesOver(headTrack, span.start, span.end).every(
    (face) => spotFaceShare(spot, face, preset) <= preset.behind.maxFaceShare + SLACK,
  );
}
