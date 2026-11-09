import type { Backgrounds } from "./background.ts";
import { bigWordCoveredShare } from "./behind.ts";
import { clicksFor } from "./clicks.ts";
import { contrastRatio, relativeLuminance } from "./contrast.ts";
import {
  type AccentChoice,
  type BigWordChoice,
  type EngineInput,
  type HookChoice,
  QUESTION_PREFIX,
  type TransitionChoice,
  type VisualChoice,
} from "./engine-input.ts";
import {
  type EngineComponent,
  type EngineElement,
  type EngineNote,
  type PlaceNote,
  type RecordNote,
  toEngineRecord,
} from "./engine-note.ts";
import {
  type LevelRole,
  type Obstacle,
  type StackElement,
  type TextElement,
  placeElement,
} from "./engine-place.ts";
import { expand, overlaps, placeBox } from "./engine-space.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import { type Box, type HeadTrack, LAYOUT_PADDING, boundingBox, facesOver } from "./head-track.ts";
import { wordsText } from "./glossary.ts";
import type { Measurer } from "./measure.ts";
import type { PickedVariants } from "./variant-picker.ts";
import type { StackVariant, TextVariant, Variant } from "./variants.ts";
import {
  type FontKey,
  PLATFORM_SAFE,
  type Preset,
  SHOWN_FLOOR_SECONDS,
  cleanWord,
} from "./preset.ts";
import {
  type Anchor,
  type BehindItem,
  type CaptionItem,
  type Edit,
  type OverlayItem,
  type TransitionItem,
  type TransitionLevel,
} from "./schema.ts";
import { anchorAt, resolveAnchor, resolveTimeline } from "./timeline.ts";
import { transitionTiming } from "./transitions.ts";
import { type SentenceSpan, type Transcript, type Word, sentenceSpans } from "./transcript.ts";

// THE LAYOUT ENGINE. Claude's answer says what and on which words; this code
// decides every time, position and size, with no randomness and no I/O:
//
// 1. Timing from the words: captions per spoken word; an accent and a question
//    exactly while their words are spoken, from the first word's start to the
//    last word's end, no minimum; a transition (LIST) from its entrance (0.3 s)
//    before its first word to its last word's end; a big word from the lead
//    before its one word to its word's end, at least 1.5 s; a visual from its
//    first word for at most the behind maximum; the hook its window (0.2 s to
//    3 s), cut to the reel. A pick with no length at all shows the shown floor
//    (`SHOWN_FLOOR_SECONDS`). No element cuts another's time: two elements
//    conflict only where they overlap on screen at the same moment, and the
//    placer keeps them apart. A text pick said in the hook's window is placed
//    around the hook, not instead of it.
// 2. The scene: the reel cut into moments wherever an item starts or ends,
//    each with its face (robust over the head track, never one reading).
// 3. Free space: an area minus the face, the platform notch and the text
//    already placed, as rectangles (`engine-space.ts`).
// 4. Placement: the components in order of their start time (ties by the
//    answer's order: the hook, accents, questions, big words, visuals, lists),
//    each avoiding the components placed before it that share a moment with
//    it (`shown`), never the captions: captions are not placed yet. Then the
//    captions last, in time order, one spot per sentence, in the free space
//    the components leave at each moment; captions avoid every component and
//    every other caption. The hook, accents, questions and LIST stacks (a
//    number, a lead-in and a key phrase as one element) go through the placer
//    (`engine-place.ts`, the spec's loop: zones, hard rules, costs; the style's
//    base size as the cap, 10% shrink steps to 30 px, free wrapping; never over
//    other text); the big word, the visual and the captions keep their own code
//    for now, and both see each other as obstacles through `shown`. The old
//    paths shrink text to the preset's floor and wrap to two lines before
//    giving up a place. The face is a preference for every front element: a
//    spot off the face and off other text first, then over the face but off
//    other text (noted `covers-face`), then (old paths only) over other text
//    (noted `kept-overlapping`). Big words are behind the speaker and ignore
//    the face. The engine drops no pick but two: a text pick whose every word
//    another text pick on screen at the same moment shows (`same-text`), and a
//    placer element with no legal spot (`no-spot`: left out, its words stay
//    captions). Of two same-text picks a big word keeps the shared words, else
//    the earlier one does. It trims or drops the other, then places the answer
//    again. A caption's words a text on screen shows are left out while it
//    shows, the caption split in time.
// 5. Fallbacks, each noted: a pick too close to the reel's end shows from
//    earlier (`clamped-to-end`); a pick over hidden footage moves to the next
//    visible moment (`moved-off-cut`); a list with no caption text of its own
//    shows the words of its phrase (`text-from-words`).
// 6. Readable text: with a background map, each text placed is measured
//    (WCAG contrast of its colour against the footage behind it, over its
//    span). Below the preset's threshold it moves to the nearest free place
//    in the same zone that reaches it, else stays where it is, plain (owner
//    decision 2026-11-04: move first, never a shadow, never a colour
//    change). A big word is never moved for it.
// 7. Every move, shrink, wrap, retime, fallback, overlap and low contrast left
//    in place is written to the record.

export type PlacedTracks = Edit["tracks"];

export interface Placement {
  tracks: PlacedTracks;
  record: EngineNote[];
}

export interface PlaceOptions {
  // What is behind the text (the footage's background map, sampled): with it
  // every text is kept readable; without it nothing is measured.
  backgrounds?: Backgrounds;
}

type Align = "left" | "right" | "center";

// A text on screen as placed: its id (a text level's transition id), what a
// note calls it, its span and its box.
interface Shown {
  id: string;
  what: string;
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

// What a note calls an accent-look item: a QUESTION or an accent.
function accentNoun(accent: AccentChoice): string {
  return accent.question ? "question" : "accent";
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
  // The robust faces around the moment, unpadded (the placer pads them itself).
  faces: Box[];
  // Their bounding box, padded for text (`LAYOUT_PADDING`); null with no head.
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
    const faces = facesOver(headTrack, start - 0.25, end + 0.25);
    const bounds = boundingBox(faces);
    const face = bounds && {
      ...bounds,
      left: bounds.left - LAYOUT_PADDING.left,
      right: bounds.right + LAYOUT_PADDING.right,
    };
    moments.push({ start, end, faces, face });
  }
  return moments;
}

const momentsOver = (scene: readonly Moment[], span: { start: number; end: number }) =>
  scene.filter((moment) => moment.start < span.end && span.start < moment.end);

// The padded faces of the moments over a span.
function facesDuring(scene: readonly Moment[], span: { start: number; end: number }): Box[] {
  return momentsOver(scene, span).flatMap((moment) => (moment.face ? [moment.face] : []));
}

// The unpadded robust faces of the moments over a span (the placer's scene).
function rawFacesDuring(scene: readonly Moment[], span: { start: number; end: number }): Box[] {
  return momentsOver(scene, span).flatMap((moment) => moment.faces);
}

// The entry a text component was picked with.
function textVariantOf(picked: PickedVariants, component: EngineComponent): TextVariant {
  const entry: Variant | undefined = picked.get(component);
  if (!entry || entry.type !== "text" || entry.style === undefined) {
    throw new Error(`engine: no text variant picked for ${component}`);
  }
  return entry;
}

// The entry the LIST was picked with: a stack.
function stackVariantOf(picked: PickedVariants): StackVariant {
  const entry: Variant | undefined = picked.get("LIST");
  if (!entry || entry.type !== "text" || entry.levels === undefined) {
    throw new Error("engine: no stack variant picked for LIST");
  }
  return entry;
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
  record: RecordNote[],
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
  // The last resort: text may be overlapped (each unit noted).
  overText?: boolean;
}

interface Line {
  units: { unit: Unit; width: number }[];
  width: number;
}

// A caption block's place: its top left corner, its width, how its lines
// align in it and its size.
interface LaidBlock {
  x: number;
  y: number;
  width: number;
  align: Align;
  size: number;
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
  // `hook`: the written hook, on its window.
  kind: "accent" | "big_word" | "visual" | "hook";
  id: string;
  start: number;
  end: number;
  // Its place in the answer's list.
  index: number;
  accent?: AccentChoice;
  visual?: VisualChoice;
  // A big word's first and last word (the same for one word).
  word?: string;
  wordTo?: string;
  hook?: HookChoice;
}

// A LIST item kept by the timing rules: its answer item and its layer's span.
// `index` is its place among all LIST items of the answer (its id is
// `transition-<index + 1>`), `list` its list's place among the answer's lists
// (1, 2, ...), `number` its place in its list when the list kept more than one
// item (none for a list of one).
interface TransitionPlan {
  ref: string;
  index: number;
  list: number;
  number?: number;
  id: string;
  label: string;
  choice: TransitionChoice;
  start: number;
  end: number;
  startAnchor: Anchor;
  endAnchor: Anchor;
}

// A text pick as placed: its answer reference (`accents[0]`, `big_words[1]`,
// ...), what a note calls it, its span, its place in the answer order (the
// same-text tie-break), whether it is a big word, and the word ids it shows, in
// transcript order.
interface TextPick {
  id: string;
  ref: string;
  name: string;
  component: EngineComponent;
  start: number;
  end: number;
  rank: number;
  big: boolean;
  words: string[];
}

// The same text never shows twice on screen (rule `same-text`). Of two text
// picks that share a word id and are on screen at the same moment (their spans
// overlap), a big word keeps the shared words over an accent, a question or a
// list; between the others, the one placed earlier (its start; on a tie, the
// rank) keeps them. Two picks that share a word but never show together both
// keep it. The other pick shows its own words only: its range is trimmed to its
// largest contiguous part without a shared word, or it is dropped when no word
// of its own is left. Null when no such pair exists. Each change is noted. The
// answer keeps every position (a dropped pick stays in it, skipped), so the
// other items keep their ids; `dropped` lists the refs to skip from now on.
function sameTextPass(
  picks: readonly TextPick[],
  answer: EngineInput,
  transcript: Transcript,
  preset: Preset,
): { answer: EngineInput; dropped: string[]; notes: PlaceNote[] } | null {
  const onScreen = (a: TextPick, b: TextPick) =>
    Math.min(a.end, b.end) - Math.max(a.start, b.start) > SLACK;
  // Big words first, then the others in time order, as the earlier one keeps.
  const order = [...picks].sort(
    (a, b) => Number(b.big) - Number(a.big) || a.start - b.start || a.rank - b.rank,
  );
  // Each word id and the picks kept so far that show it.
  const keepers = new Map<string, TextPick[]>();
  const trimmed = new Map<string, string[]>();
  const dropped: string[] = [];
  const notes: PlaceNote[] = [];
  const position = new Map(transcript.words.map((word, slot) => [word.id, slot]));
  for (const pick of order) {
    const clashing = (id: string) =>
      (keepers.get(id) ?? []).filter((other) => onScreen(other, pick));
    const shared = pick.words.filter((id) => clashing(id).length > 0);
    if (shared.length === 0) {
      for (const id of pick.words) keepers.set(id, [...(keepers.get(id) ?? []), pick]);
      continue;
    }
    const own = pick.words.filter((id) => !shared.includes(id));
    const keeperList = [...new Set(shared.flatMap(clashing))];
    // Named without times: the keeper's span may still be cut by a later pick.
    const named = keeperList.map((other) => other.name).join(" and ");
    const why = keeperList.some((other) => other.big)
      ? "a big word keeps the shared words first"
      : "the earlier pick";
    const sharedText = quote(wordsText(shared, transcript, preset));
    if (own.length === 0) {
      dropped.push(pick.ref);
      notes.push({
        item: pick.id,
        action: "dropped",
        rule: "same-text",
        reason: `${pick.name} is dropped: every word it shows, ${sharedText}, is already shown by ${named}, ${why}`,
      });
      continue;
    }
    // The largest run of its own words that the transcript keeps together.
    const runs: string[][] = [];
    for (const id of own) {
      const run = runs.at(-1);
      if (run && position.get(id)! === position.get(run.at(-1)!)! + 1) run.push(id);
      else runs.push([id]);
    }
    const kept = runs.reduce((best, run) => (run.length > best.length ? run : best));
    for (const id of kept) keepers.set(id, [...(keepers.get(id) ?? []), pick]);
    trimmed.set(pick.ref, kept);
    notes.push({
      item: pick.id,
      action: "retimed",
      rule: "same-text",
      reason: `${pick.name} shows only ${quote(wordsText(kept, transcript, preset))}, not its shared ${sharedText}: ${named} shows that text, ${why}`,
    });
  }
  if (trimmed.size === 0 && dropped.length === 0) return null;
  // Each trimmed pick takes its kept run as its range (a list's key phrase
  // stays on its first word when the run does not hold it).
  const trim = <T extends { from: string; to: string }>(choice: T, ref: string): T => {
    const kept = trimmed.get(ref);
    if (!kept) return choice;
    return { ...choice, from: kept[0]!, to: kept.at(-1)! };
  };
  return {
    answer: {
      ...answer,
      accents: answer.accents.map((choice, slot) => trim(choice, `accents[${slot}]`)),
      questions: answer.questions.map((choice, slot) => trim(choice, `questions[${slot}]`)),
      big_words: answer.big_words.map((choice, slot) => trim(choice, `big_words[${slot}]`)),
      lists: answer.lists.map((list, listIndex) => ({
        items: list.items.map((choice, slot) => {
          const kept = trimmed.get(`lists[${listIndex}].items[${slot}]`);
          if (!kept) return choice;
          const key_from = kept.includes(choice.key_from) ? choice.key_from : kept[0]!;
          return { ...choice, from: kept[0]!, to: kept.at(-1)!, key_from };
        }),
      })),
    },
    dropped,
    notes,
  };
}

// Places every item of an answer over the current version: footage kept,
// captions from the current version's words (each fix as the text of the
// caption showing that word), every other item from its words, and a click
// as each visual and big word comes in. Every pick is placed, an overlap is
// kept and noted, and a text pick whose words another text pick shows is
// trimmed or dropped (`same-text`), the only drop there is.
export function placeEdit(
  current: Edit,
  input: EngineInput,
  // The entry each component's pick was given (`variant-picker.ts`): the placer
  // reads an accent's or a question's; the record names every component's.
  picked: PickedVariants,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  options: PlaceOptions = {},
): Placement {
  // Each pass places the answer as it stands; a pass that leaves a pick out
  // (no legal spot) or trims or drops one (same-text) is placed again, so the
  // rules hold on the placed times. Every pass removes at least one word from a
  // pick or a pick from the answer, so this ends.
  let answer = input;
  const skip = new Set<string>();
  const notes: RecordNote[] = [];
  // Every pick of any pass by id: a pick the same-text rule drops is in no
  // track, but its note still names its span and component.
  const picks = new Map<string, TextPick>();
  for (;;) {
    const placed = placeOnce(
      current,
      answer,
      picked,
      transcript,
      headTrack,
      preset,
      measurer,
      options,
      skip,
    );
    for (const pick of placed.picks) picks.set(pick.id, pick);
    if (placed.noSpot.length > 0) {
      // No legal spot (the spec's "No legal spot"): the element is left out of
      // this version, the answer placed again without it so its words show as
      // captions (rule 3); its `no-spot` note is the one kept from this pass.
      for (const ref of placed.noSpot) skip.add(ref);
      notes.push(
        ...placed.record.filter((note) => "outcome" in note && note.outcome === "no-spot"),
      );
      continue;
    }
    const pass = sameTextPass(placed.picks, answer, transcript, preset);
    if (!pass) {
      const all = [...notes, ...placed.record];
      return {
        tracks: placed.tracks,
        record: engineRecord(current, placed.tracks, all, picks, transcript, picked),
      };
    }
    answer = pass.answer;
    for (const ref of pass.dropped) skip.add(ref);
    notes.push(...pass.notes);
  }
}

// The engine record of a placement: each shown element's span from its track
// (resolved through the transcript), the dropped picks' from their last pass.
function engineRecord(
  current: Edit,
  tracks: PlacedTracks,
  notes: readonly RecordNote[],
  picks: ReadonlyMap<string, TextPick>,
  transcript: Transcript,
  picked: PickedVariants,
): EngineNote[] {
  const timeline = resolveTimeline({ ...current, tracks }, transcript);
  const elements = new Map<string, EngineElement>();
  for (const pick of picks.values()) {
    elements.set(pick.id, { component: pick.component, start: pick.start, end: pick.end });
  }
  const shown: string[] = [];
  const show = (id: string, component: EngineComponent) => {
    const at = timeline.get(id);
    if (!at) throw new Error(`engine record: ${id} has no span`);
    elements.set(id, { component, start: at.start, end: at.end });
    shown.push(id);
  };
  for (const item of tracks.overlays) {
    if (item.id === HOOK_ID) {
      show(item.id, "HOOK");
      continue;
    }
    const pick = picks.get(item.id);
    if (!pick) throw new Error(`engine record: overlay ${item.id} is no pick`);
    show(item.id, pick.component);
  }
  for (const item of tracks.transitions) show(item.id, "LIST");
  for (const item of tracks.behind ?? []) {
    show(item.id, item.kind === "word" ? "BIGWORD" : "VISUAL");
  }
  // A caption a component shows is no element on screen (no `placed` note),
  // but its notes (a retime made before it was hidden) still name its span.
  const captionIds = new Set(tracks.captions.map((caption) => caption.id));
  for (const caption of tracks.captions) {
    const at = timeline.get(caption.id);
    if (!at) throw new Error(`engine record: caption ${caption.id} has no span`);
    elements.set(caption.id, { component: "CAPTION", start: at.start, end: at.end });
    if (caption.hidden_by === undefined) shown.push(caption.id);
  }
  return toEngineRecord(notes, elements, shown, captionIds, picked);
}

function placeOnce(
  current: Edit,
  input: EngineInput,
  picked: PickedVariants,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  options: PlaceOptions,
  // The refs of picks dropped by the same-text rule or left out for no legal
  // spot: placed as nothing.
  skip: ReadonlySet<string>,
): { tracks: PlacedTracks; record: RecordNote[]; picks: TextPick[]; noSpot: string[] } {
  const record: RecordNote[] = [];
  // The refs of the picks this pass found no legal spot for.
  const noSpot: string[] = [];
  const duration = current.duration;
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const word = (id: string) => byId.get(id)!;
  const order = new Map(transcript.words.map((w, index) => [w.id, index]));
  const range = (from: string, to: string) =>
    transcript.words.slice(order.get(from)!, order.get(to)! + 1).map((w) => w.id);
  // A big word's text: its one or two words, cleaned, joined by a space.
  const bigWordText = (from: string, to: string) =>
    range(from, to)
      .map((id) => cleanWord(word(id).text, preset))
      .join(" ");
  const sentences = sentenceSpans(transcript);
  const sentenceOf = (id: string): SentenceSpan | undefined => {
    const index = order.get(id)!;
    return sentences.find((s) => order.get(s.from)! <= index && index <= order.get(s.to)!);
  };
  const { layout } = preset;
  const safe = SAFE_ZONE.box;
  const gap = layout.gap;
  const notch = SAFE_ZONE.notch;
  const safeCx = (safe.left + safe.right) / 2;
  const hidden = current.tracks.footage.flatMap((clip) =>
    (clip.hidden ?? []).map((span) => ({
      start: resolveAnchor(span.start, byId, duration),
      end: resolveAnchor(span.end, byId, duration),
    })),
  );

  // The written hook's window, fixed by the pace (from `fromSeconds` to
  // `untilSeconds`, inside the reel). Nothing said in it cuts it; a hook the
  // placer found no spot for is skipped.
  const hook = skip.has(HOOK_REF) ? null : hookExtra(input.hook ?? null);

  function hookExtra(choice: HookChoice | null): Extra | null {
    if (!choice) return null;
    const spec = preset.pace.hook;
    const text = hookText(choice);
    let start = ms(Math.min(spec.fromSeconds, duration));
    const end = ms(Math.min(duration, spec.untilSeconds));
    // The reel ends too soon after the hook's start, so it shows from earlier,
    // to the reel's end.
    if (end - start < SHOWN_FLOOR_SECONDS - SLACK) {
      start = ms(Math.max(0, end - SHOWN_FLOOR_SECONDS));
      record.push({
        item: HOOK_ID,
        action: "clamped-to-end",
        rule: "hook-time",
        reason: `the hook ${quote(text)} shows from ${at(start)} to ${at(end)}: the reel is too short to start it at ${at(spec.fromSeconds)}`,
      });
    }
    return {
      ref: HOOK_REF,
      kind: "hook",
      id: HOOK_ID,
      start,
      end,
      index: 0,
      hook: { text },
    };
  }

  function transitionText(choice: TransitionChoice): string {
    return wordsText(range(choice.from, choice.to), transcript, preset);
  }

  function timeTransitions(): TransitionPlan[] {
    const kept: TransitionPlan[] = [];
    let index = 0;
    input.lists.forEach((list, listIndex) =>
      list.items.forEach((choice, position) => {
        const flat = index++;
        const ref = `lists[${listIndex}].items[${position}]`;
        if (skip.has(ref)) return;
        const id = `transition-${flat + 1}`;
        const label = `list ${listIndex + 1} item ${position + 1} on ${quote(transitionText(choice))}`;
        const kind = preset.transitions.numbered;
        const timing = transitionTiming(
          { from: choice.from, to: choice.to },
          transcript.words,
          duration,
          preset,
          kind,
        );
        // The layer comes in as its first word starts, its entrance before it,
        // whatever else is on screen then.
        let start = timing?.start ?? 0;
        let end = timing?.end ?? ms(duration);
        const startAnchor: Anchor = timing?.startAnchor ?? { reel: "start" };
        const endAnchor: Anchor = timing?.endAnchor ?? { reel: "end" };
        if (!timing) {
          // The reel is shorter than the shown floor, so the layer covers all of it.
          start = 0;
          end = ms(duration);
          record.push({
            item: id,
            action: "clamped-to-end",
            rule: "transition-time",
            reason: `${label} shows from 0 s to ${at(duration)}: the reel is too short for it to show ${SHOWN_FLOOR_SECONDS} s`,
          });
        } else if (timing.lengthened) {
          record.push({
            item: id,
            action: "retimed",
            rule: "transition-min",
            reason: `${label} shows from ${at(start)} to ${at(end)}, at least ${SHOWN_FLOOR_SECONDS} s`,
          });
        }
        kept.push({
          ref,
          index: flat,
          list: listIndex + 1,
          id,
          label,
          choice,
          start,
          end,
          startAnchor,
          endAnchor,
        });
      }),
    );
    // A list's kept items number 1, 2, ... in reel order (as the speaker goes
    // through them); a list left with one kept item shows no number.
    const itemsOf = new Map<number, TransitionPlan[]>();
    for (const plan of [...kept].sort((a, b) => a.start - b.start)) {
      itemsOf.set(plan.list, [...(itemsOf.get(plan.list) ?? []), plan]);
    }
    const numberOf = new Map<string, number>();
    for (const items of itemsOf.values()) {
      if (items.length > 1) items.forEach((plan, position) => numberOf.set(plan.id, position + 1));
    }
    return kept
      .map((plan) => ({ ...plan, number: numberOf.get(plan.id) }))
      .sort((a, b) => a.start - b.start);
  }

  // The extras' own times. A pick's span is its own: from its start to its
  // last word's end (a big word and a visual from the lead before it, below).
  const { minSeconds, maxSeconds } = preset.behind;
  // A big word comes in the preset's lead before its word, so its entrance has
  // finished as the word is heard; never before the reel.
  const leadStart = (wordStart: number) => ms(Math.max(0, wordStart - preset.accent.leadSeconds));
  // A pick with no length at all (its words take no time) shows the shown
  // floor from its start, earlier where the reel ends: the floor only guards
  // against a zero-length pick, it is no minimum.
  function floorSpan(start: number, end: number): { start: number; end: number } {
    if (end - start > SLACK) return { start, end };
    const from = ms(Math.max(0, Math.min(start, duration - SHOWN_FLOOR_SECONDS)));
    return { start: from, end: ms(Math.min(duration, from + SHOWN_FLOOR_SECONDS)) };
  }
  // The start anchor of an item coming in at `at`: its word, plus the offset
  // from the word's start (none for an accent or a question).
  const startAnchorOf = (id: string, at: number): Anchor => {
    const offset = ms(at - word(id).start);
    if (Math.abs(offset) > 1) return anchorAt(at, transcript.words);
    return offset === 0 ? { word: id } : { word: id, offset };
  };
  const crossesHidden = (span: { start: number; end: number }) =>
    hidden.some((range) => during(span, range));

  // A pick over hidden footage: the next visible moment after the cut (from
  // its end, as long as the pick lasts, up to the next cut), else the last one
  // before it. Null when neither holds the shown floor.
  function visibleSpan(span: {
    start: number;
    end: number;
  }): { start: number; end: number } | null {
    const length = span.end - span.start;
    const cuts = hidden.filter((range) => during(span, range)).sort((a, b) => a.start - b.start);
    for (const cut of cuts) {
      const nextCut = hidden
        .filter((range) => range.start >= cut.end - SLACK)
        .reduce((best, range) => Math.min(best, range.start), duration);
      const start = ms(cut.end);
      const end = ms(Math.min(nextCut, duration, start + length));
      if (end - start >= SHOWN_FLOOR_SECONDS - SLACK) return { start, end };
    }
    for (const cut of [...cuts].reverse()) {
      const prevCut = hidden
        .filter((range) => range.end <= cut.start + SLACK)
        .reduce((best, range) => Math.max(best, range.end), 0);
      const end = ms(cut.start);
      const start = ms(Math.max(prevCut, cut.start - length));
      if (end - start >= SHOWN_FLOOR_SECONDS - SLACK) return { start, end };
    }
    return null;
  }

  // A pick's own span, from its start (the lead before its first word) to its
  // last word's end, at least `min` long and at most `max`, inside the reel.
  function ownSpan(
    startAt: number,
    lastEnd: number,
    min: number,
    max: number,
  ): { start: number; end: number } {
    const end = ms(Math.min(duration, Math.max(lastEnd, startAt + min), startAt + max));
    return { start: ms(startAt), end };
  }

  // An ACCENT (`accents[i]`) or a QUESTION (`questions[i]`, `ref`): the same
  // placement, timing and look.
  function accentExtra(
    accent: AccentChoice,
    index: number,
    id: string,
    ref = `accents[${index}]`,
  ): Extra {
    // Exactly while its words are spoken, like a caption: from the first
    // word's start to the last word's end.
    const own = ownSpan(word(accent.from).start, word(accent.to).end, 0, Infinity);
    const span = floorSpan(own.start, own.end);
    if (span.start !== own.start || span.end !== own.end) {
      record.push({
        item: id,
        action: "clamped-to-end",
        rule: "accent-time",
        reason: `${accentNoun(accent)} ${quote(accentText(accent))} shows from ${at(span.start)} to ${at(span.end)}: its words take no time, so it shows the shown floor`,
      });
    }
    return { ref, kind: "accent", id, start: span.start, end: span.end, index, accent };
  }

  // A big word: from the lead before its first word to its last word's end, at
  // least the accent's minimum (the spec's `words` with `lead` and `minimum`).
  // Its time comes from its words alone: no other text moves or cuts it.
  function bigWordExtra(choice: BigWordChoice, index: number, id: string): Extra {
    const ref = `big_words[${index}]`;
    // Timed from its first word to its last (the same word for one word).
    const first = word(choice.from);
    const last = word(choice.to);
    const own = ownSpan(leadStart(first.start), last.end, preset.accent.minSeconds, Infinity);
    let start = own.start;
    let end = own.end;
    const text = bigWordText(choice.from, choice.to);
    if (end - start < SHOWN_FLOOR_SECONDS - SLACK) {
      // Too close to the reel's end, so it shows from earlier.
      start = ms(Math.max(0, end - SHOWN_FLOOR_SECONDS));
      record.push({
        item: id,
        action: "clamped-to-end",
        rule: "big-word-time",
        reason: `the big word ${quote(text)} shows from ${at(start)} to ${at(end)}: the reel ends too soon to start it at its word`,
      });
    }
    if (crossesHidden({ start, end })) {
      const moved = visibleSpan({ start, end });
      if (moved) {
        record.push({
          item: id,
          action: "moved-off-cut",
          rule: "hidden-footage",
          reason: `the big word ${quote(text)} would show while the footage is hidden: it shows from ${at(moved.start)} to ${at(moved.end)}, the next visible moment`,
        });
        ({ start, end } = moved);
      }
    }
    return {
      ref,
      kind: "big_word",
      id,
      start,
      end,
      index,
      word: first.id,
      wordTo: last.id,
    };
  }

  function visualExtra(visual: VisualChoice, index: number, id: string): Extra {
    const ref = `visuals[${index}]`;
    const sentence = sentenceOf(visual.from)!;
    // From the visual's first word, so it shows over its own words.
    const first = word(visual.from);
    let { start, end } = ownSpan(first.start, word(visual.to).end, minSeconds, maxSeconds);
    start = ms(start);
    end = ms(end);
    if (end - start < SHOWN_FLOOR_SECONDS - SLACK) {
      // Too close to the reel's end, so it shows from earlier.
      start = ms(Math.max(0, end - SHOWN_FLOOR_SECONDS));
      record.push({
        item: id,
        action: "clamped-to-end",
        rule: "visual-time",
        reason: `visual ${index + 1} shows from ${at(start)} to ${at(end)}: the reel ends too soon to start it at its sentence`,
      });
    }
    if (crossesHidden({ start, end })) {
      const moved = visibleSpan({ start, end });
      if (moved) {
        record.push({
          item: id,
          action: "moved-off-cut",
          rule: "hidden-footage",
          reason: `visual ${index + 1} would show while the footage is hidden: it shows from ${at(moved.start)} to ${at(moved.end)}, the next visible moment`,
        });
        ({ start, end } = moved);
      }
    }
    if (start < Math.min(sentence.start, first.start) - SLACK) {
      record.push({
        item: id,
        action: "retimed",
        rule: "visual-time",
        reason: `visual ${index + 1} starts at ${at(start)}, before its short sentence, to show ${minSeconds} s`,
      });
    }
    return { ref, kind: "visual", id, start, end, index, visual };
  }

  const extras: Extra[] = hook ? [hook] : [];
  // Ids follow the answer's positions, so a pick the same-text rule drops
  // leaves the others' ids as they are.
  input.accents.forEach((accent, index) => {
    if (skip.has(`accents[${index}]`)) return;
    extras.push(accentExtra(accent, index, `accent-${index + 1}`));
  });
  // A QUESTION: an accent placed the same way, under its own id (`question-N`).
  const { questions } = input;
  questions.forEach((question, index) => {
    if (skip.has(`questions[${index}]`)) return;
    const accent = { ...question, question: true };
    extras.push(
      accentExtra(accent, index, `${QUESTION_PREFIX}${index + 1}`, `questions[${index}]`),
    );
  });
  input.big_words.forEach((choice, index) => {
    if (skip.has(`big_words[${index}]`)) return;
    extras.push(bigWordExtra(choice, index, bigWordId(index)));
  });
  input.visuals.forEach((visual, index) => {
    extras.push(visualExtra(visual, index, `visual-${index + 1}`));
  });

  // Transitions, timed from their words (their entrance before the first word).
  const transitionPlans = timeTransitions();

  // A component's place in the answer order, the tie-break when two start at
  // the same moment: the hook, then the accents, the questions, the big words,
  // the visuals, the lists (spec decision 8).
  const rankOf = (extra: Extra) =>
    extra.kind === "hook"
      ? 0
      : extra.kind === "accent"
        ? extra.accent!.question
          ? 2
          : 1
        : extra.kind === "big_word"
          ? 3
          : 4;
  const LIST_RANK = 5;

  // The captions: the current version's, split in time where a text on screen
  // shows their words. A caption's words that a text shows (an accent, a big
  // word, a list's phrase) are left out only while that text is on screen: a
  // run of words that all are is one caption `hidden_by` that text, and the
  // other runs stay captions of their own (a cut list's later words show as
  // captions). A split caption's pieces get the caption's id, then `-2`, `-3`.
  const fixes = new Map(input.word_fixes.map((fix) => [fix.word, fix.text]));
  const onScreen = [
    ...extras.flatMap((extra) =>
      extra.kind === "accent" || extra.kind === "big_word"
        ? [
            {
              id: extra.id,
              start: extra.start,
              end: extra.end,
              words: new Set(
                extra.kind === "accent"
                  ? range(extra.accent!.from, extra.accent!.to)
                  : range(extra.word!, extra.wordTo!),
              ),
            },
          ]
        : [],
    ),
    ...transitionPlans.map((plan) => ({
      id: plan.id,
      start: plan.start,
      end: plan.end,
      words: new Set(range(plan.choice.from, plan.choice.to)),
    })),
  ];
  // The text on screen over a word in its own time, if any.
  const coveredBy = (id: string): string | undefined => {
    const spoken = byId.get(id)!;
    return onScreen.find((text) => text.words.has(id) && during(text, spoken))?.id;
  };
  function splitCaption(caption: CaptionItem): CaptionItem[] {
    const runs: { by: string | undefined; words: string[] }[] = [];
    for (const id of caption.words) {
      const by = coveredBy(id);
      const last = runs.at(-1);
      if (last && last.by === by) last.words.push(id);
      else runs.push({ by, words: [id] });
    }
    return runs.map((run, index) => ({
      ...caption,
      ...(index === 0 ? {} : { id: `${caption.id}-${index + 1}` }),
      words: run.words,
      ...(index === 0 ? {} : { start: { word: run.words[0]!, edge: "start" as const } }),
      ...(index === runs.length - 1
        ? {}
        : { end: { word: run.words.at(-1)!, edge: "end" as const } }),
      ...(run.by !== undefined ? { hidden_by: run.by } : {}),
    }));
  }
  const captions = current.tracks.captions
    .flatMap((caption) => {
      const rest: CaptionItem = { ...caption };
      delete rest.text;
      delete rest.position;
      delete rest.size;
      delete rest.breaks;
      delete rest.hidden_by;
      return splitCaption(rest);
    })
    .map((caption) => {
      const fixed = caption.words.filter((id) => fixes.has(id)).map((id) => fixes.get(id)!);
      return fixed.length > 0 ? { ...caption, text: fixed.join(" ") } : caption;
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
  // The texts on screen over `span` that a box (with the gap around it) overlaps.
  const textsOver = (box: Box, span: { start: number; end: number }): Shown[] =>
    shown.filter((item) => during(item, span) && overlaps(box, expand(item.box, gap)));
  // A kept-overlapping note on the texts a box sits over: its `with` (their
  // ids) and their names for the reason.
  const overWith = (texts: readonly Shown[]) => ({
    with: [...new Set(texts.map((item) => item.id))],
    names: [...new Set(texts.map((item) => item.what))].join(" and "),
  });
  // A front pick placed over the face (when `faceRule`) is noted `covers-face`
  // under that rule: the face is a preference, so it is covered only when no
  // spot off it was free. A pick placed over other text on screen is noted
  // `kept-overlapping` with the texts it sits over.
  function noteOverlap(
    id: string,
    label: string,
    box: Box,
    span: { start: number; end: number },
    faceRule?: string,
  ): void {
    if (faceRule && faceObstacles(span).some((obstacle) => overlaps(box, obstacle))) {
      record.push({
        item: id,
        action: "covers-face",
        rule: faceRule,
        reason: `${label} covers the face from ${at(span.start)} to ${at(span.end)}: no spot off the face was free, so it sits over part of it`,
      });
    }
    const texts = textsOver(box, span);
    if (texts.length === 0) return;
    const named = overWith(texts);
    record.push({
      item: id,
      action: "kept-overlapping",
      rule: "all-picks",
      reason: `${label} sits over ${named.names} from ${at(span.start)} to ${at(span.end)}; kept, every pick is shown`,
      with: named.with,
    });
  }

  // Readability: the worst contrast of a text's colours over a box and span.
  const { backgrounds } = options;
  const { readability } = preset;
  type Threshold = { min: number };
  function contrastOf(
    sampler: Backgrounds,
    box: Box,
    span: { start: number; end: number },
    lights: readonly number[],
  ): number {
    let worst = Infinity;
    for (const light of lights) {
      worst = Math.min(worst, contrastRatio(light, sampler.behind(box, span, light)));
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
    lights: readonly number[],
    threshold: Threshold,
    measured: (box: Box) => Box = (box) => box,
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
      const ratio = contrastOf(sampler, measured(box), span, lights);
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

  // What a text placed at `from` does for contrast: stays (readable, or no
  // map), moves to a readable free place, or stays plain where it is with a
  // note (never a shadow, never a colour change).
  function keepReadable(
    item: string,
    label: string,
    box: { x: number; y: number; width: number; height: number },
    span: { start: number; end: number },
    colors: readonly string[],
    threshold: Threshold,
    zone: { area: Box; obstacles: readonly Box[] } | null,
    why: string,
  ): { x: number; y: number } {
    const from = { x: box.x, y: box.y };
    if (!backgrounds) return from;
    const placed = {
      left: box.x,
      right: box.x + box.width,
      top: box.y,
      bottom: box.y + box.height,
    };
    const lights = colors.map(relativeLuminance);
    const ratio = contrastOf(backgrounds, placed, span, lights);
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
          lights,
          threshold,
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
    record.push({
      item,
      action: "low-contrast",
      rule: "contrast-stay",
      reason: `${label} ${label.startsWith("captions ") ? "stay" : "stays"} in place: contrast ${ratioText(ratio)} ${when}, ${why}`,
    });
    return from;
  }

  // The LIST items as transition items, each placed as one stack in its turn
  // among the components (below). The captions of a transition's phrase show
  // only as its levels.
  const transitionItems = new Map<string, { index: number; item: TransitionItem }>();

  // The text of a LIST item's levels: the number, the lead-in (the words before
  // `key_from`) and the key phrase, as the captions show them.
  function levelTexts(plan: TransitionPlan): { lead: string; key: string } {
    const { choice, label } = plan;
    const ids = range(choice.from, choice.to);
    const phrase = new Set(ids);
    const keyAt = order.get(choice.key_from)!;
    // The phrase's text, after the word fixes: each word as the caption
    // showing it (once per caption), a word no caption shows as itself. A
    // caption goes to the lead-in or the key phrase by its first word; one
    // starting before the phrase keeps its own place and is left out here.
    const captionOf = new Map<string, number>();
    captions.forEach((caption, index) => {
      if (caption.hidden_by !== plan.id) return;
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
    let lead = leadParts.map((part) => part.text).join(" ");
    let key = keyParts.map((part) => part.text).join(" ");
    // A phrase whose captions all begin before it has no text of its own, so
    // its words (as the captions would show them, after the fixes) are its
    // text. A text over the level's cap is cut at a word.
    if (!key) {
      key =
        ids
          .map((id) => fixes.get(id) ?? wordsText([id], transcript, preset))
          .join(" ")
          .trim() || ids.map((id) => word(id).text.trim()).join(" ");
      lead = "";
      record.push({
        item: plan.id,
        action: "text-from-words",
        rule: "transition-text",
        reason: `${label} has no caption text of its own: it shows the words of its phrase, ${quote(key)}`,
      });
    }
    const capped = (text: string) => {
      if (text.length <= LEVEL_TEXT_MAX) return text;
      let out = "";
      for (const piece of text.split(" ")) {
        const next = out ? `${out} ${piece}` : piece;
        if (next.length > LEVEL_TEXT_MAX) break;
        out = next;
      }
      record.push({
        item: plan.id,
        action: "text-from-words",
        rule: "transition-text",
        reason: `${label} shows its first ${out.length} characters: its text is longer than ${LEVEL_TEXT_MAX}`,
      });
      return out;
    };
    lead = lead.length > LEVEL_TEXT_MAX ? capped(lead) : lead;
    key = key.length > LEVEL_TEXT_MAX ? capped(key) : key;
    return { lead, key };
  }

  // A LIST item through the placer (`engine-place.ts`): one stack of its
  // number (a list of two or more items), its lead-in (when it has one) and its
  // key phrase, from the entry the LIST was picked with (`list/numbered`),
  // placed once as a whole over the texts on screen with it. The stack's box
  // becomes the levels' positions (each centred on the stack, `align` center),
  // sizes and `breaks`, and joins `shown` for the item's whole span. False when
  // no candidate keeps the hard rules: the item is left out (see the loop).
  function placeStack(plan: TransitionPlan): boolean {
    const { choice, label, number } = plan;
    const ids = range(choice.from, choice.to);
    const { lead, key } = levelTexts(plan);
    const starts: Record<LevelRole, Anchor> = {
      number: plan.startAnchor,
      lead: { word: choice.from },
      key: { word: choice.key_from },
    };
    const element: StackElement = {
      type: "stack",
      id: plan.id,
      variant: stackVariantOf(picked),
      levels: [
        ...(number !== undefined ? [{ role: "number" as const, text: String(number) }] : []),
        ...(lead ? [{ role: "lead" as const, text: lead }] : []),
        { role: "key" as const, text: key },
      ],
      gap: preset.transition.gap,
      start: plan.start,
      end: plan.end,
    };
    const result = placeElement(element, sceneFor(plan), measurer);
    record.push(...result.notes);
    if (!result.placed) return false;
    const { box } = result.placed;
    const centre = Math.round(((box.left + box.right) / 2) * 100) / 100;
    const levels: Partial<Record<LevelRole, TransitionLevel>> = {};
    let y = box.top;
    for (const level of result.placed.levels) {
      const text = element.levels.find((entry) => entry.role === level.role)!.text;
      levels[level.role] = {
        text,
        start: starts[level.role],
        position: { x: centre, y, align: "center" },
        size: level.size,
        ...(level.lines.length > 1 ? { breaks: level.breaks } : {}),
      };
      y += level.height + preset.transition.gap;
    }
    shown.push({
      id: plan.id,
      what: `the text of ${label}`,
      start: plan.start,
      end: plan.end,
      box,
    });
    transitionItems.set(plan.id, {
      index: plan.index,
      item: {
        id: plan.id,
        type: "numbered",
        start: plan.startAnchor,
        end: plan.endAnchor,
        words: ids,
        key: choice.key_from,
        list: plan.list,
        ...(number !== undefined ? { number } : {}),
        levels: { ...levels, key: levels.key! },
      },
    });
    return true;
  }

  // Captions: blocks in time order, each a sentence's groups (one spot for the
  // whole sentence); a transition's own captions show only as its levels.
  const blocks: CaptionBlock[] = [];
  const sentenceBlocks = new Map<SentenceSpan | undefined, CaptionBlock>();
  groups.forEach((group, index) => {
    const end = ends[index]!;
    // A caption a text shows while it is on screen (`hidden_by`) has no place
    // of its own: the captions left in a group are placed, and only they take
    // room in the block.
    const outside = group.filter((unit) => unit.caption.hidden_by === undefined);
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
  const placedCaptions = new Map<number, { x: number; y: number; size: number }>();

  const overlays = new Map<string, OverlayItem>();
  const behind = new Map<string, BehindItem>();

  // The components in order of their start time, ties by the answer's order
  // (`rankOf`, the lists last), each avoiding the ones placed before it that
  // share a moment with it. The captions come last, in the space the
  // components leave.
  const components = [
    ...extras.map((extra) => ({
      start: extra.start,
      rank: rankOf(extra) * 1000 + extra.index,
      place: () => tryExtra(extra),
    })),
    ...transitionPlans.map((plan) => ({
      start: plan.start,
      rank: LIST_RANK * 1000 + plan.index,
      place: () => {
        if (!placeStack(plan)) noSpot.push(plan.ref);
      },
    })),
  ].sort((a, b) => a.start - b.start || a.rank - b.rank);
  for (const component of components) component.place();
  for (const block of blocks) placeBlock(block);

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

  function tryBlock(
    block: CaptionBlock,
    candidate: Candidate,
    size: number,
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
    return { ...spot, width, height, layouts };
  }

  // What a caption block keeps clear of: the face (unless it is the worst
  // case over it), the text shown with it (unless it is the last resort over
  // the text) and the notch.
  function blockObstacles(block: CaptionBlock, candidate: Candidate): Box[] {
    return [
      ...(candidate.overFace ? [] : faceObstacles(block)),
      ...(candidate.overText ? [] : textDuring(block)),
      notch,
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
    } | null = null;
    // Captions stay readable first: every place at the full size before any
    // smaller size.
    for (const size of sizes) {
      for (const candidate of candidates) {
        const fit = tryBlock(block, candidate, size);
        if (fit) {
          chosen = { candidate, size, fit };
          break;
        }
      }
      if (chosen) break;
    }
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
        const fit = tryBlock(block, worst, floor);
        if (fit) {
          chosen = { candidate: worst, size: floor, fit };
          break;
        }
      }
      if (!chosen) {
        // Over the face and other text (the last resort, each unit noted with
        // the texts it sits over), wrapped as far as it takes: the caption line,
        // else the top of the safe zone.
        for (const area of [{ ...safe, top: preset.caption.fallbackY }, safe]) {
          const over: Candidate = {
            name: "over the face and other text",
            area,
            align: "center",
            want: (w, h) => ({ x: safeCx, y: area.top + h / 2 }),
            maxLines: 99,
            overFace: true,
            overText: true,
          };
          const fit = tryBlock(block, over, floor);
          if (fit) {
            chosen = { candidate: over, size: floor, fit };
            break;
          }
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
            overText: true,
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
        };
      }
      // One note for the block: its other captions sit over the face with it
      // (`with`), and the face check passes each of them as noted.
      const others = block.groups
        .flat()
        .map((unit) => unit.caption.id)
        .filter((id) => id !== first.caption.id);
      record.push({
        item: first.caption.id,
        action: "covers-face",
        rule: "caption-face",
        reason: `captions ${quote(label)} (${at(block.start)} to ${at(block.end)}) found no free place and sit ${chosen.candidate.name}`,
        ...(others.length > 0 ? { with: others } : {}),
      });
    } else if (chosen.candidate !== candidates[0]) {
      record.push({
        item: first.caption.id,
        action: "moved",
        rule: "caption-spot",
        reason: `captions ${quote(label)} (${at(block.start)} to ${at(block.end)}) sit ${chosen.candidate.name}: no room ${candidates[0]!.name}`,
      });
    }
    const { candidate, size, fit } = chosen;
    const fullSize = preset.fonts[captionFont].size;
    if (size < fullSize) {
      record.push({
        item: first.caption.id,
        action: "shrunk",
        rule: "caption-size",
        reason: `captions ${quote(label)} set at ${size} px instead of ${fullSize} px to fit`,
      });
    }
    // Readable over the footage; captions over the face are never moved
    // for it.
    const place = keepReadable(
      first.caption.id,
      `captions ${quote(label)}`,
      fit,
      block,
      [...new Set(block.groups.flat().map((unit) => unit.caption.color ?? preset.caption.color))],
      readability.caption,
      candidate.overFace
        ? null
        : { area: candidate.area, obstacles: blockObstacles(block, candidate) },
      candidate.overFace
        ? "captions over the face are never moved"
        : `no free place nearby reaches ${readability.caption.min}:1`,
    );
    const laid: LaidBlock = {
      x: place.x,
      y: place.y,
      width: fit.width,
      align: candidate.align,
      size,
    };
    for (const lines of fit.layouts) layLines(lines, laid, true, candidate.overText === true);
  }

  // One group's lines at their places inside its block: each unit's corner,
  // and (while placing) its box as shown.
  // `noteOver`: the last resort, where a unit may sit over other text (noted
  // with what it sits over, before its own box is shown).
  function layLines(
    lines: readonly Line[],
    laid: LaidBlock,
    show: boolean,
    noteOver = false,
  ): void {
    const { size } = laid;
    const space = measurer.width(captionFont, size, " ");
    let y = laid.y;
    for (const line of lines) {
      let x =
        laid.align === "left"
          ? laid.x
          : laid.align === "right"
            ? laid.x + laid.width - line.width
            : laid.x + (laid.width - line.width) / 2;
      for (const { unit, width } of line.units) {
        const left = Math.floor(x * 100) / 100;
        placedCaptions.set(unit.index, {
          x: left,
          y,
          size,
        });
        if (show) {
          const box = { left, right: left + width, top: y, bottom: y + size };
          const span = { start: unit.start, end: unitEnd.get(unit.index)! };
          const texts = textsOver(box, span);
          if (noteOver && texts.length > 0) {
            const named = overWith(texts);
            record.push({
              item: unit.caption.id,
              action: "kept-overlapping",
              rule: "all-picks",
              reason: `caption ${quote(unit.text)} sits over ${named.names} from ${at(span.start)} to ${at(span.end)}; kept, every pick is shown`,
              with: named.with,
            });
          }
          shown.push({
            id: unit.caption.id,
            what: `caption ${quote(unit.text)}`,
            start: span.start,
            end: span.end,
            box,
          });
        }
        x += width + space;
      }
      y += size + preset.caption.lineGap;
    }
  }

  // One extra at its own span, placed by its kind. The old kinds (big word,
  // visual) are always placed (over the face or other text if they must,
  // noted); a placer element (the hook, an accent, a question) it finds no
  // legal spot for is left out, noted `no-spot`, and `placeEdit` places the
  // answer again without it.
  function tryExtra(extra: Extra): void {
    const span = { start: extra.start, end: extra.end };
    if (extra.kind === "hook") {
      if (!placeHook(extra, span)) noSpot.push(extra.ref);
    } else if (extra.kind === "accent") {
      if (!placeAccent(extra, span)) noSpot.push(extra.ref);
    } else if (extra.kind === "big_word") placeBigWord(extra, span);
    else placeVisual(extra, span);
  }

  // The placer's scene over a span: the unpadded robust faces of its moments
  // and every text on screen with it as a `text` obstacle (captions come last
  // and are none yet).
  function sceneFor(span: { start: number; end: number }) {
    const obstacles: Obstacle[] = shown
      .filter((item) => during(item, span))
      .map((item) => ({ id: item.id, kind: "text", box: item.box }));
    return { faces: rawFacesDuring(scene, span), obstacles, safe: SAFE_ZONE };
  }

  function describe(extra: Extra): string {
    if (extra.kind === "hook") return `the hook ${quote(extra.hook!.text)}`;
    if (extra.kind === "accent") {
      const accent = extra.accent!;
      return `${accentNoun(accent)} ${quote(accentText(accent))}`;
    }
    if (extra.kind === "big_word") {
      return `the big word ${quote(bigWordText(extra.word!, extra.wordTo!))}`;
    }
    return `visual ${extra.index + 1}`;
  }

  function accentText(accent: AccentChoice): string {
    return wordsText(range(accent.from, accent.to), transcript, preset);
  }

  // An accent or a question through the placer (`engine-place.ts`): the
  // element from the entry its component was picked with (`accent/above-head`,
  // `question/as-accent`), the scene from the moments of its span (the robust
  // faces, unpadded; every component on screen with it placed before it as an
  // obstacle; captions come last and are none yet). Its position, size and
  // `breaks` are the placer's; the notes go to the record as they are. False
  // when no candidate keeps the hard rules: the element is left out (see
  // `tryExtra`).
  function placeAccent(extra: Extra, span: { start: number; end: number }): boolean {
    const accent = extra.accent!;
    const ids = range(accent.from, accent.to);
    const text = wordsText(ids, transcript, preset);
    const element: TextElement = {
      type: "text",
      id: extra.id,
      variant: textVariantOf(picked, accent.question ? "QUESTION" : "ACCENT"),
      text,
      lineGap: 0,
      start: span.start,
      end: span.end,
    };
    const result = placeElement(element, sceneFor(span), measurer);
    record.push(...result.notes);
    if (!result.placed) return false;
    const { box, size, lines, breaks } = result.placed;
    overlays.set(extra.id, {
      id: extra.id,
      kind: "accent",
      start: startAnchorOf(accent.from, span.start),
      end: { word: accent.to, edge: "end" },
      words: ids,
      position: { x: box.left, y: box.top, align: "left" },
      size,
      ...(lines.length > 1 ? { breaks } : {}),
    });
    shown.push({
      id: extra.id,
      what: `${accentNoun(accent)} ${quote(text)}`,
      start: span.start,
      end: span.end,
      box,
    });
    return true;
  }

  // The written hook through the placer: the element of the entry it was
  // picked with (`hook/written-line`: the upper third, then anywhere in the
  // safe zone, the accent style), over its whole window, around whatever is
  // on screen with it. Its position, size and `breaks` are the placer's. False
  // when no candidate keeps the hard rules (settled: a hook that fits nowhere
  // at 30 px or more is a `no-spot` like any element, left out of the version;
  // nobody says it, so no caption stands in for it).
  function placeHook(extra: Extra, span: { start: number; end: number }): boolean {
    const text = extra.hook!.text;
    const element: TextElement = {
      type: "text",
      id: extra.id,
      variant: textVariantOf(picked, "HOOK"),
      text,
      lineGap: 0,
      start: span.start,
      end: span.end,
    };
    const result = placeElement(element, sceneFor(span), measurer);
    record.push(...result.notes);
    if (!result.placed) return false;
    const { box, size, lines, breaks } = result.placed;
    overlays.set(extra.id, {
      id: extra.id,
      kind: "hook",
      text,
      start: anchorAt(span.start, transcript.words),
      end: anchorAt(span.end, transcript.words),
      position: { x: box.left, y: box.top, align: "left" },
      size,
      ...(lines.length > 1 ? { breaks } : {}),
    });
    shown.push({ id: extra.id, what: describe(extra), start: span.start, end: span.end, box });
    return true;
  }

  function placeBigWord(extra: Extra, span: { start: number; end: number }): void {
    const first = word(extra.word!);
    const text = bigWordText(extra.word!, extra.wordTo!);
    const spec = preset.behind.word;
    const { width: frameWidth, height: frameHeight } = preset.frame;
    const perPx = measurer.width(spec.font, 1, text);
    const fit = perPx > 0 ? Math.floor((frameWidth - 2 * spec.margin) / perPx) : spec.maxSize;
    const largest = Math.max(8, Math.min(spec.maxSize, fit));
    const sizes = sizesFrom(largest, preset).filter((size) => size >= 8);
    const face = facesOver(headTrack, span.start, span.start)[0] ?? null;
    const centre = face ? face.top + spec.belowHeadTop : spec.noHeadY;
    // Never above the platforms' safe top (they cover the frame there); it
    // crosses the style's safe box by design.
    const area = {
      left: spec.margin,
      right: frameWidth - spec.margin,
      top: Math.max(spec.margin, PLATFORM_SAFE.top),
      bottom: frameHeight - spec.margin,
    };
    // The head rule's wanted centre at a size. The head is no obstacle (the
    // word sits behind it by design); the text on screen is.
    const wantedAt = (size: number) => ({
      x: frameWidth / 2,
      y: Math.max(area.top + size / 2, centre),
    });
    // The face in front over its span: most of the word stays in view, only
    // its lower part behind the head.
    const faces = facesOver(headTrack, span.start, span.end);
    const maxCovered = 1 - spec.minVisible;
    const covered = (spot: { x: number; y: number }, width: number, size: number) =>
      bigWordCoveredShare(
        { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + size },
        faces,
      );
    // The nearest place to the rule's centre clear of the text on screen, at
    // the largest size that has one (`shrunk` below the largest). With none at
    // any size, the default spot: the rule's place at the largest size that
    // fits, the text overlap noted. The head is never moved for either.
    let chosen: { spot: { x: number; y: number }; size: number; width: number } | null = null;
    for (const size of sizes) {
      const width = perPx * size;
      const spot = placeBox(area, textDuring(span), width, size, wantedAt(size));
      if (spot) {
        chosen = { spot, size, width };
        break;
      }
    }
    if (!chosen) {
      for (const size of sizes) {
        const width = perPx * size;
        const spot = placeBox(area, [], width, size, wantedAt(size));
        if (spot) {
          chosen = { spot, size, width };
          break;
        }
      }
    }
    // Last resort: the smallest size at the area's corner (never dropped).
    if (!chosen) {
      const size = sizes.at(-1)!;
      chosen = { spot: { x: area.left, y: area.top }, size, width: perPx * size };
    }
    const { spot, size, width } = chosen;
    const notes = record.length;
    // The head overlapping it is the design: never moved for contrast.
    keepReadable(
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
    const box = { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + size };
    noteOverlap(extra.id, `the big word ${quote(text)}`, box, span);
    const share = covered(spot, width, size);
    if (share > maxCovered + SLACK) {
      record.push({
        item: extra.id,
        action: "kept-overlapping",
        rule: "all-picks",
        reason: `the big word ${quote(text)} sits with the person covering ${Math.round(share * 100)}% of it from ${at(span.start)} to ${at(span.end)}; kept, every pick is shown`,
      });
    }
    // Moved from the rule's own place for the text on screen.
    const atRule = placeBox(area, [], width, size, wantedAt(size));
    if (atRule && (spot.x !== atRule.x || spot.y !== atRule.y)) {
      record.push({
        item: extra.id,
        action: "moved",
        rule: "big-word-spot",
        reason: `the big word ${quote(text)} moves ${Math.round(Math.hypot(spot.x - atRule.x, spot.y - atRule.y))} px to a place clear of the text on screen from ${at(span.start)} to ${at(span.end)}`,
      });
    }
    behind.set(extra.id, {
      id: extra.id,
      kind: "word",
      text,
      start: startAnchorOf(first.id, span.start),
      end: anchorAt(
        span.end,
        transcript.words.filter((w) => w.start >= first.start),
      ),
      position: spot,
      size,
      words: range(extra.word!, extra.wordTo!),
    });
    shown.push({
      id: extra.id,
      what: `the big word ${quote(text)}`,
      start: span.start,
      end: span.end,
      box: { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + size },
    });
    if (size < largest) {
      record.push({
        item: extra.id,
        action: "shrunk",
        rule: "big-word-size",
        reason: `the big word ${quote(text)} set at ${size} px instead of ${largest} px to fit`,
      });
    }
    record.push(...contrastNotes);
  }

  // A visual's card: an empty white stroke frame, a small corner card (picture
  // in picture) over the footage. The full size first, then the smaller step;
  // at each, the spot with the most free space around it (`card.spots`):
  // inside the platform safe zone, clear of the face and the other text (the
  // hook, accents, big words, lists; captions are placed after it), and off
  // the button column.
  function cardSize(smaller: boolean): { width: number; height: number } {
    const card = preset.behind.card;
    const width = Math.round(preset.frame.width * card.widthShare * (smaller ? card.smaller : 1));
    return { width, height: Math.round(width / card.aspect) };
  }

  // The card's spots at a size that the obstacles leave clear, ranked by free
  // space around them, the most first.
  function cardSpots(
    span: { start: number; end: number },
    size: { width: number; height: number },
    obstacles: readonly Box[],
  ): Box[] {
    const card = preset.behind.card;
    const area = PLATFORM_SAFE;
    const { width, height } = size;
    const face = boundingBox(facesDuring(scene, span));
    const boxAt = (left: number, top: number): Box => ({
      left,
      right: left + width,
      top,
      bottom: top + height,
    });
    const boxes: Box[] = [];
    for (const spot of card.spots) {
      if (spot === "beside-left" || spot === "beside-right") {
        if (!face) continue;
        const top = Math.min(Math.max(face.top, area.top), area.bottom - height);
        boxes.push(
          spot === "beside-left"
            ? boxAt(face.left - gap - width, top)
            : boxAt(face.right + gap, top),
        );
        continue;
      }
      const left = spot.endsWith("left") ? area.left + card.inset : area.right - card.inset - width;
      const top = spot.startsWith("top")
        ? area.top + card.inset
        : area.bottom - card.inset - height;
      boxes.push(boxAt(left, top));
    }
    return boxes
      .filter(
        (box) =>
          box.left >= area.left &&
          box.right <= area.right &&
          box.top >= area.top &&
          box.bottom <= area.bottom &&
          !obstacles.some((obstacle) => overlaps(box, obstacle)),
      )
      .map((box) => {
        // The ring around the spot: the share no obstacle covers is its free space.
        const around = expand(box, card.ring);
        const ring = (around.right - around.left) * (around.bottom - around.top) - width * height;
        const covered = obstacles.reduce((sum, obstacle) => {
          const w = Math.min(obstacle.right, around.right) - Math.max(obstacle.left, around.left);
          const h = Math.min(obstacle.bottom, around.bottom) - Math.max(obstacle.top, around.top);
          return w > 0 && h > 0 ? sum + w * h : sum;
        }, 0);
        return { box, free: 1 - Math.min(1, covered / ring) };
      })
      .sort((a, b) => b.free - a.free)
      .map(({ box }) => box);
  }

  // A visual: the first card spot it fits, off the face and the other text, at
  // the full size, then at the smaller step; only when no such spot is free,
  // over the face (noted `covers-face`) at either size, off the other text;
  // last, over other text at the full size (noted `kept-overlapping`), at the
  // first spot in the safe zone, else the corner. Its white edge too close to
  // the footage around it moves it to a place nearby that separates them, else
  // it stays, recorded.
  function placeVisual(extra: Extra, span: { start: number; end: number }): void {
    const index = extra.index;
    const visual = extra.visual!;
    const label = `visual ${index + 1}`;
    const when = `from ${at(span.start)} to ${at(span.end)}`;
    const spec = preset.behind.edge;
    // The frame's white stroke is the edge the contrast check measures.
    const edge = 1;
    const textAndNotch = [...textDuring(span), notch];
    const obstacles = [...textAndNotch, ...faceObstacles(span)];
    const full = cardSize(false);
    const smallSize = cardSize(true);
    const tried = [
      { smaller: false, size: full, avoid: obstacles, over: null },
      { smaller: true, size: smallSize, avoid: obstacles, over: null },
      { smaller: false, size: full, avoid: textAndNotch, over: null },
      { smaller: true, size: smallSize, avoid: textAndNotch, over: null },
      { smaller: false, size: full, avoid: [notch], over: "text" },
    ];
    for (const { smaller, size, avoid, over } of tried) {
      const found =
        cardSpots(span, size, avoid)[0] ??
        (over
          ? {
              left: PLATFORM_SAFE.left,
              right: PLATFORM_SAFE.left + size.width,
              top: PLATFORM_SAFE.top,
              bottom: PLATFORM_SAFE.top + size.height,
            }
          : undefined);
      if (!found) continue;
      const { width, height } = size;
      const boxAt = (spot: { x: number; y: number }): Box => ({
        left: spot.x,
        right: spot.x + width,
        top: spot.y,
        bottom: spot.y + height,
      });
      let spot = { x: found.left, y: found.top };
      const notes: PlaceNote[] = [];
      if (backgrounds) {
        const around = (box: Box) => expand(box, spec.ring);
        const ratio = contrastOf(backgrounds, around(boxAt(spot)), span, [edge]);
        if (ratio < spec.minContrast) {
          const threshold = { min: spec.minContrast };
          const moved = readablePlace(
            backgrounds,
            PLATFORM_SAFE,
            avoid,
            width,
            height,
            spot,
            span,
            [edge],
            threshold,
            around,
          );
          if (moved) {
            spot = { x: moved.x, y: moved.y };
            notes.push({
              item: extra.id,
              action: "moved",
              rule: "contrast-spot",
              reason: `${label} moves ${Math.round(moved.distance)} px to a place it stands out from: contrast ${ratioText(ratio)} against the footage around it ${when}, under ${spec.minContrast}:1, now ${ratioText(moved.ratio)}`,
            });
          } else {
            notes.push({
              item: extra.id,
              action: "low-contrast",
              rule: "contrast-stay",
              reason: `${label} stays in place: contrast ${ratioText(ratio)} against the footage around it ${when}, no free place nearby reaches ${spec.minContrast}:1; a visual never gets a shadow or a colour change`,
            });
          }
        }
      }
      const box = boxAt(spot);
      noteOverlap(extra.id, label, box, span, "visual-face");
      const sentence = sentenceOf(visual.from)!;
      behind.set(extra.id, {
        id: extra.id,
        kind: "visual",
        ...(visual.description ? { description: visual.description } : {}),
        box: { x: spot.x, y: spot.y, width, height },
        start:
          Math.abs(span.start - sentence.start) < 0.0005
            ? { word: sentence.from }
            : Math.abs(span.start - word(visual.from).start) < 0.0005
              ? { word: visual.from }
              : anchorAt(span.start, transcript.words),
        end: anchorAt(span.end, transcript.words),
      });
      if (smaller) {
        record.push({
          item: extra.id,
          action: "shrunk",
          rule: "visual-size",
          reason: `${label} set at ${width} by ${height} px instead of ${full.width} by ${full.height}: no corner or side is free at full size ${when}`,
        });
      }
      record.push(...notes);
      return;
    }
  }

  // The tracks, in the current version's caption order and the answer's order.
  // A caption a text shows while it is on screen has no place of its own.
  const outCaptions: CaptionItem[] = captions.map((caption, index) => {
    const lastWord = unitEndWord.get(index)!;
    const end = unitEnd.get(index)!;
    const offset = ms(end - lastWord.end);
    const endAnchor: Anchor =
      offset === 0
        ? { word: lastWord.id, edge: "end" }
        : { word: lastWord.id, edge: "end", offset };
    const place = placedCaptions.get(index);
    if (caption.hidden_by !== undefined) return { ...caption, end: endAnchor };
    if (!place) return { ...caption, end: endAnchor };
    return {
      ...caption,
      end: endAnchor,
      position: { x: place.x, y: place.y, align: "left" },
      size: place.size,
    };
  });
  const outOverlays: OverlayItem[] = [];
  const hookItem = overlays.get(HOOK_ID);
  if (hookItem) outOverlays.push(hookItem);
  for (const extra of extras) {
    if (extra.kind !== "accent") continue;
    const item = overlays.get(extra.id);
    if (!item) continue;
    const from = byId.get((item.start as { word: string }).word)!;
    outOverlays.push({
      ...item,
      end: anchorAt(
        extra.end,
        transcript.words.filter((w) => w.start >= from.start),
      ),
    });
  }
  const outBehind: BehindItem[] = [];
  for (const extra of extras) {
    if (extra.kind === "accent" || extra.kind === "hook") continue;
    const item = behind.get(extra.id);
    if (!item) continue;
    const start = resolveAnchor(item.start, byId, duration);
    outBehind.push({
      ...item,
      end: anchorAt(
        extra.end,
        transcript.words.filter((w) => w.start >= start),
      ),
    });
  }
  // Pictures before the big words, each kind as the answer lists them.
  outBehind.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "word" ? 1 : -1));

  // The sounds: a click as each placed visual and big word comes in
  // (`clicks.ts`); the current version's sounds are never kept.
  const outSounds = clicksFor(
    outBehind,
    (item) => resolveAnchor(item.start, byId, duration),
    preset,
  );

  const picks: TextPick[] = [
    ...extras.flatMap((extra) =>
      extra.kind === "accent" || extra.kind === "big_word"
        ? [
            {
              id: extra.id,
              ref: extra.ref,
              name: describe(extra),
              component:
                extra.kind === "big_word"
                  ? ("BIGWORD" as const)
                  : extra.accent!.question
                    ? ("QUESTION" as const)
                    : ("ACCENT" as const),
              start: extra.start,
              end: extra.end,
              rank: rankOf(extra) * 1000 + extra.index,
              big: extra.kind === "big_word",
              words:
                extra.kind === "accent"
                  ? range(extra.accent!.from, extra.accent!.to)
                  : range(extra.word!, extra.wordTo!),
            },
          ]
        : [],
    ),
    ...transitionPlans.map((plan) => ({
      id: plan.id,
      ref: plan.ref,
      name: plan.label,
      component: "LIST" as const,
      start: plan.start,
      end: plan.end,
      rank: 4000 + plan.index,
      big: false,
      words: range(plan.choice.from, plan.choice.to),
    })),
  ];

  return {
    picks,
    noSpot,
    tracks: {
      footage: current.tracks.footage,
      captions: outCaptions,
      overlays: outOverlays,
      transitions: [...transitionItems.values()]
        .sort((a, b) => a.index - b.index)
        .map(({ item }) => item),
      sounds: outSounds,
      ...(outBehind.length > 0 ? { behind: outBehind } : {}),
    },
    record,
  };
}

// The longest text of a transition's level (the schema's cap).
const LEVEL_TEXT_MAX = 300;

// The hook's answer reference (in a checklist) and item id.
const HOOK_REF = "hook";
const HOOK_ID = "hook";

// The hook's text as shown: one space between words.
function hookText(choice: HookChoice): string {
  return choice.text.trim().split(/\s+/).join(" ");
}

// A big word's item id by its place in the answer: `big-word-1`, ...
function bigWordId(index: number): string {
  return `big-word-${index + 1}`;
}
