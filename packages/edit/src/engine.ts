import type { Backgrounds } from "./background.ts";
import { bigWordCoveredShare, nearestSpot } from "./behind.ts";
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
import { expand, overlaps, placeBox } from "./engine-space.ts";
import { type Box, type HeadTrack, LAYOUT_PADDING, boundingBox, facesOver } from "./head-track.ts";
import { wordsText } from "./glossary.ts";
import type { Measurer } from "./measure.ts";
import {
  type FontKey,
  PLATFORM_BUTTONS,
  PLATFORM_SAFE,
  type Preset,
  SHOWN_FLOOR_SECONDS,
  cleanWord,
  intersectBox,
} from "./preset.ts";
import {
  type Anchor,
  MIN_TEXT_SIZE,
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
// 1. Timing from the words: captions per spoken word; an accent and a question
//    exactly while their words are spoken, from the first word's start to the
//    last word's end, no minimum; a transition (LIST) from its entrance (0.3 s)
//    before its first word to its last word's end; a big word from the lead
//    before its one word to `afterSeconds` after it (at least 1.5 s, a target);
//    a visual from its first word for at most the behind maximum. A pick with
//    no length at all shows the shown floor (`SHOWN_FLOOR_SECONDS`).
//    Text components (the hook, accents, questions, big words, lists) never
//    share the screen in time and none waits: the earlier one ends where the
//    later one starts (`text-one-at-a-time`). A cut that leaves a hook or a big
//    word shorter than the floor shows the floor over the text that cut it.
//    Visuals are not text and are never cut.
// 2. The scene: the reel cut into moments wherever an item starts or ends,
//    each with its face (robust over the head track, never one reading).
// 3. Free space: an area minus the face, the platform notch and the text
//    already placed, as rectangles (`engine-space.ts`).
// 4. Placement: each transition's text levels (its phrase's captions, shown
//    only there), then the written hook in its fixed slot, then the other
//    components in answer order (accents, questions, big words, visuals), which
//    never avoid captions: captions are not placed yet. Then the captions last,
//    in time order, one spot per sentence, in the free space the components
//    leave at each moment; captions avoid every component and every other
//    caption. Text shrinks to the preset's floor and wraps to two lines before
//    it gives up a place. The face is a preference for every front element
//    (hook, accents, questions, list levels, visual cards, captions): a spot
//    off the face and off other text first, then over the face but off other
//    text (noted `covers-face`), then over other text (noted
//    `kept-overlapping`). Big words are behind the speaker and ignore the face.
//    The engine drops no pick but one: a text pick whose every word another
//    text pick on screen at the same moment shows (`same-text`). Of two such
//    picks a big word keeps the shared words, else the earlier one does. It
//    trims or drops the other, then places the answer again. A caption's words a
//    text on screen shows are left out while it shows, the caption split in time.
// 5. Fallbacks, each noted: a pick too close to the reel's end shows from
//    earlier (`clamped-to-end`); a pick over hidden footage moves to the next
//    visible moment (`moved-off-cut`); a list with no caption text of its own
//    shows the words of its phrase (`text-from-words`); a list's entrance cut
//    short by a text said before it (`transition-entrance`).
// 6. Readable text: with a background map, each text placed is measured
//    (WCAG contrast of its colour against the footage behind it, over its
//    span). Below the preset's threshold it moves to the nearest free place
//    in the same zone that reaches it, else stays where it is, plain (owner
//    decision 2026-11-04: move first, never a shadow, never a colour
//    change). A big word is never moved for it.
// 7. Every move, shrink, wrap, retime, fallback, overlap and low contrast left
//    in place is written to the record.

// What the engine did to an item, in plain words.
export type EngineAction =
  | "moved"
  | "shrunk"
  | "wrapped"
  | "retimed"
  // A front pick or caption placed over the face because no spot off the face
  // was free (the reason says so).
  | "covers-face"
  // A text that stays in place, plain, below its contrast threshold: no free
  // place nearby reads, and no shadow or colour is ever added for it.
  | "low-contrast"
  // A pick placed over other text, or at the same time as another pick, kept
  // as it is (the reason says what it sits over).
  | "kept-overlapping"
  // A pick too close to the reel's end for its minimum, shown from earlier so
  // it still shows (its end is the reel's end).
  | "clamped-to-end"
  // A pick over hidden footage, shown at the next visible moment.
  | "moved-off-cut"
  // A transition or a list pick with no caption text of its own, shown with
  // the words of its phrase as its text.
  | "text-from-words"
  // A text pick every word of which another text pick (placed earlier) shows
  // already: dropped (rule `same-text`, the reason names both picks).
  | "dropped";

export interface EngineNote {
  item: string;
  action: EngineAction;
  rule: string;
  reason: string;
  // A `kept-overlapping` note on a text: the ids of the other texts it sits
  // over or shares its time with (the pairs the text-overlap check excuses).
  // A `covers-face` note on a caption block: the block's other captions, which
  // sit over the face with it (the face check excuses each of them).
  with?: string[];
}

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
  // `transition`: a running transition, accepted before every extra. `hook`:
  // the written hook, placed first among the extras, never cut short.
  kind: "accent" | "big_word" | "visual" | "hook" | "transition";
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

// A transition kept by the timing rules: its answer item and its layer's span.
interface TransitionPlan {
  ref: string;
  index: number;
  id: string;
  label: string;
  choice: TransitionChoice;
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

// A text pick as placed: its answer reference (`accents[0]`, `big_words[1]`,
// ...), what a note calls it, its span, its place in the answer order (the
// one-at-a-time rank), whether it is a big word, and the word ids it shows, in
// transcript order.
interface TextPick {
  id: string;
  ref: string;
  name: string;
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
): { answer: EngineInput; dropped: string[]; notes: EngineNote[] } | null {
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
  const notes: EngineNote[] = [];
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
      transitions: answer.transitions.map((choice, slot) => {
        const kept = trimmed.get(`transitions[${slot}]`);
        if (!kept) return choice;
        const key_from = kept.includes(choice.key_from) ? choice.key_from : kept[0]!;
        return { ...choice, from: kept[0]!, to: kept.at(-1)!, key_from };
      }),
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
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  options: PlaceOptions = {},
): Placement {
  // Each pass places the answer as it stands; a pass that trims or drops a
  // pick is placed again, so the rule holds on the placed times. Every pass
  // removes at least one word from a pick or a pick from the answer, so this
  // ends.
  let answer = input;
  const skip = new Set<string>();
  const notes: EngineNote[] = [];
  for (;;) {
    const placed = placeOnce(
      current,
      answer,
      transcript,
      headTrack,
      preset,
      measurer,
      options,
      skip,
    );
    const pass = sameTextPass(placed.picks, answer, transcript, preset);
    if (!pass) return { tracks: placed.tracks, record: [...notes, ...placed.record] };
    answer = pass.answer;
    for (const ref of pass.dropped) skip.add(ref);
    notes.push(...pass.notes);
  }
}

function placeOnce(
  current: Edit,
  input: EngineInput,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  options: PlaceOptions,
  // The refs of picks dropped by the same-text rule: placed as nothing.
  skip: ReadonlySet<string>,
): Placement & { picks: TextPick[] } {
  const record: EngineNote[] = [];
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

  // The written hook's window, fixed by the pace (from `fromSeconds` to
  // `untilSeconds`, inside the reel), known before anything else.
  const hook = hookExtra(input.hook ?? null);

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
    input.transitions.forEach((choice, index) => {
      const ref = `transitions[${index}]`;
      if (skip.has(ref)) return;
      const id = `transition-${index + 1}`;
      const label = `transition ${index + 1} (${choice.kind}) on ${quote(transitionText(choice))}`;
      const kind = preset.transitions[choice.kind];
      const timing = transitionTiming(
        { from: choice.from, to: choice.to },
        transcript.words,
        duration,
        preset,
        kind,
      );
      let start = timing?.start ?? 0;
      let end = timing?.end ?? ms(duration);
      let startAnchor: Anchor = timing?.startAnchor ?? { reel: "start" };
      const endAnchor: Anchor = timing?.endAnchor ?? { reel: "end" };
      const first = word(choice.from).start;
      // The layer comes in as its first word starts, its entrance before it; but
      // never before the text picks that started earlier have ended (it comes
      // in later, the entrance shorter), and never after its first word.
      const earlierEnd = Math.max(
        0,
        ...[...extras, ...kept]
          .filter((pick) => pick.start < first - SLACK)
          .map((pick) => pick.end),
      );
      if (timing && earlierEnd > start + SLACK) {
        const was = start;
        start = ms(Math.min(earlierEnd, first));
        startAnchor =
          Math.abs(start - first) < 0.0005
            ? { word: choice.from }
            : anchorAt(start, transcript.words);
        record.push({
          item: id,
          action: "retimed",
          rule: "transition-entrance",
          reason: `${label} comes in from ${at(start)}, not from ${at(was)}: the text before it ends at ${at(earlierEnd)}, and text picks show one at a time`,
        });
      }
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
        index,
        id,
        label,
        choice,
        start,
        end,
        startAnchor,
        endAnchor,
      });
    });
    return kept.sort((a, b) => a.start - b.start);
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

  // A big word takes the accent's timing, its one word both first and last:
  // from the lead before it to `afterSeconds` after it, at least the accent's
  // minimum (a target: a text starting later cuts it short).
  function bigWordExtra(choice: BigWordChoice, index: number, id: string): Extra {
    const ref = `big_words[${index}]`;
    // Timed from its first word to its last (the same word for one word).
    const first = word(choice.from);
    const last = word(choice.to);
    // Its lead, but never earlier than a text that starts inside that lead
    // (before its word): it comes in with that text.
    const lead = leadStart(first.start);
    const from = Math.max(
      lead,
      ...extras
        .filter(
          (pick) =>
            pick.kind !== "visual" &&
            pick.start > lead + SLACK &&
            pick.start <= first.start + SLACK,
        )
        .map((pick) => pick.start),
    );
    const own = ownSpan(from, last.end, preset.accent.minSeconds, Infinity);
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

  // Transitions, timed from their words (their entrance before the first word)
  // after the other text picks, which they may not cut into.
  const transitionPlans = timeTransitions();

  // A text pick's place in the answer order: the hook first, then the accents,
  // the questions, the big words, the lists.
  const rankOf = (extra: Extra) =>
    extra.kind === "hook" ? 0 : extra.kind === "accent" ? (extra.accent!.question ? 2 : 1) : 3;
  oneTextAtATime();

  // Text components (the hook, accents, questions, big words, lists) one at a
  // time (rule `text-one-at-a-time`), and none waits for another: in the order
  // they start (a tie going to the answer's order, the hook first), the earlier
  // one ends where the later one starts. A piece cut to no length keeps the
  // shown floor from its start, over the later one, noted as overlapping (a
  // big word too short for its length, the same).
  function oneTextAtATime(): void {
    type Piece = { rank: number; name: string; pick: Extra | TransitionPlan };
    const pieces: Piece[] = [
      ...extras
        .filter(
          (extra) => extra.kind === "hook" || extra.kind === "accent" || extra.kind === "big_word",
        )
        .map((extra) => ({
          rank: rankOf(extra) * 1000 + extra.index,
          name: describe(extra),
          pick: extra,
        })),
      ...transitionPlans.map((plan) => ({ rank: 4000 + plan.index, name: plan.label, pick: plan })),
    ];
    const ordered = [...pieces].sort((a, b) => a.pick.start - b.pick.start || a.rank - b.rank);
    ordered.forEach((later, slot) => {
      for (const earlier of ordered.slice(0, slot)) {
        if (earlier.pick.end <= later.pick.start + SLACK) continue;
        const was = earlier.pick.end;
        earlier.pick.end = ms(later.pick.start);
        setAnchors(earlier.pick);
        record.push({
          item: earlier.pick.id,
          action: "retimed",
          rule: "text-one-at-a-time",
          reason: `${earlier.name} shows from ${at(earlier.pick.start)} to ${at(earlier.pick.end)}, not to ${at(was)}: ${later.name} starts at ${at(later.pick.start)}, and text picks show one at a time; the words it no longer shows show as captions`,
        });
      }
    });
    // A piece with no length left shows the shown floor where the checks need
    // it (the hook, a big word); an accent or a list only needs a positive length.
    for (const piece of ordered) {
      const needed =
        "choice" in piece.pick || piece.pick.kind === "accent" ? 0.001 : SHOWN_FLOOR_SECONDS;
      if (piece.pick.end - piece.pick.start >= needed) continue;
      const span = floorSpan(piece.pick.start, piece.pick.start);
      const from = piece.pick.start;
      piece.pick.start = span.start;
      piece.pick.end = span.end;
      setAnchors(piece.pick);
      record.push({
        item: piece.pick.id,
        action: "retimed",
        rule: "text-one-at-a-time",
        reason: `${piece.name} has no length left after a cut at ${at(from)}: it shows the shown floor, ${at(span.start)} to ${at(span.end)}, over the text it starts with`,
      });
    }
  }

  // A LIST's anchors follow its times. An extra's anchors are set where it is
  // placed, from its times.
  function setAnchors(pick: Extra | TransitionPlan): void {
    if (!("startAnchor" in pick)) return;
    pick.startAnchor =
      pick.start === 0 ? { reel: "start" } : anchorAt(pick.start, transcript.words);
    pick.endAnchor =
      pick.end === ms(duration) ? { reel: "end" } : anchorAt(pick.end, transcript.words);
  }

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
      delete rest.break_after;
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

  // Transitions take the screen over: each one's text levels (its number, its
  // lead-in, its key phrase) are placed before any caption, in free space
  // inside its area, off the face where possible. The captions of a
  // transition's phrase show only as its levels.
  const transitionItems = new Map<string, { index: number; item: TransitionItem }>();
  let numbered = 0;
  for (const plan of transitionPlans) {
    const number = plan.choice.kind === "numbered" ? numbered + 1 : undefined;
    const item = placeLevels(plan, number);
    if (number !== undefined) numbered = number;
    transitionItems.set(plan.id, { index: plan.index, item });
  }

  function placeLevels(plan: TransitionPlan, number: number | undefined): TransitionItem {
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
    const specs = [
      ...(number !== undefined
        ? [{ role: "number" as const, text: String(number), start: plan.startAnchor }]
        : []),
      ...(lead ? [{ role: "lead" as const, text: lead, start: { word: choice.from } }] : []),
      { role: "key" as const, text: key, start: { word: choice.key_from } },
    ].map((spec) => ({ ...spec, ...levelStyle(spec.role, preset) }));
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
      // The smallest size, wrapped as far as it goes, at the wanted place, over
      // other text if it must (noted).
      const step = steps - 1;
      const wrapped = wraps.at(-1)!;
      const stack = stackOf(step, wrapped);
      const spot = placeBox(area, [], stack.width, stack.height, {
        x: cx,
        y: kind.want + stack.height / 2,
      }) ?? { x: area.left, y: area.top };
      noteOverlap(
        plan.id,
        label,
        { left: spot.x, right: spot.x + stack.width, top: spot.y, bottom: spot.y + stack.height },
        plan,
        "transition-face",
      );
      found = { stack, spot, step, wrapped, overFace: false };
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
        id: plan.id,
        what: `the text of ${label}`,
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

  // A transition is kept as placed by its own timing; no other pick trims it.
  const accepted: Accepted[] = transitionPlans.map((plan) => ({
    extra: {
      ref: plan.ref,
      kind: "transition",
      id: plan.id,
      start: plan.start,
      end: plan.end,
      index: plan.index,
    },
    start: plan.start,
    end: plan.end,
  }));
  const overlays = new Map<string, OverlayItem>();
  const behind = new Map<string, BehindItem>();

  // The components in their order: the written hook first (its slot is fixed),
  // then the accents, questions, big words and visuals in answer order. The
  // captions come last, in the space the components leave.
  for (const extra of extras) tryExtra(extra);
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

  // One extra at its own span: placed by its kind (every kind is always
  // placed, over the face or other text if it must, and noted), then kept.
  function tryExtra(extra: Extra): void {
    const span = { start: extra.start, end: extra.end };
    if (extra.kind === "hook") placeHook(extra, span);
    else if (extra.kind === "accent") placeAccent(extra, span);
    else if (extra.kind === "big_word") placeBigWord(extra, span);
    else placeVisual(extra, span);
    const together = accepted.filter((entry) => during(span, entry));
    if (together.length > 0) {
      record.push({
        item: extra.id,
        action: "kept-overlapping",
        rule: "all-picks",
        reason: `${describe(extra)} (${at(span.start)} to ${at(span.end)}) shows at the same time as ${together.map((entry) => describe(entry.extra)).join(", ")}; both kept, every pick is shown`,
        with: [...new Set(together.map((entry) => entry.extra.id))],
      });
    }
    accepted.push({ extra, start: span.start, end: span.end });
  }

  function describe(extra: Extra): string {
    if (extra.kind === "transition") return `transition ${extra.index + 1}`;
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

  function placeAccent(extra: Extra, span: { start: number; end: number }): void {
    const accent = extra.accent!;
    const ids = range(accent.from, accent.to);
    const text = wordsText(ids, transcript, preset);
    const font = preset.accent.font;
    const fullSize = preset.fonts[font].size;
    const face = boundingBox(facesDuring(scene, span));
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
    const base = face ? ["above", "top", "anywhere"] : ["line", "anywhere"];
    const candidates = base.map((name) => areas[name]!);
    // Clear of the face, the other text and the notch (the chest is free: a
    // spot there is as good as any other).
    const clear = [...faceObstacles(span), ...textDuring(span), notch];
    const words = text.split(" ");
    const sizes = sizesFrom(fullSize, preset);
    // Tiers: clear of the face, the text and the notch; then clear of the text
    // and the notch only (the face covered, noted); only then the default spot
    // anyway (the first candidate's wanted point, text overlap allowed), at the
    // largest size that fits, never below the schema minimum.
    const textOnly = [...textDuring(span), notch];
    const anyway: Candidate = {
      name: "at its default spot",
      area: safe,
      align: "center",
      want: candidates[0]!.want,
      maxLines: 2,
    };
    const anySizes = [...sizes];
    for (let size = (sizes.at(-1) ?? fullSize) - 1; size >= MIN_TEXT_SIZE; size -= 1) {
      anySizes.push(size);
    }
    const tiers = [
      { list: candidates, obstacles: clear, sizes, overlapping: false },
      { list: candidates, obstacles: textOnly, sizes, overlapping: false },
      { list: [anyway], obstacles: [notch], sizes: anySizes, overlapping: true },
    ];
    for (const { list, obstacles, sizes: tierSizes, overlapping } of tiers) {
      for (const candidate of list) {
        for (const size of tierSizes) {
          for (const lineCount of words.length > 1 ? [1, 2] : [1]) {
            const lines = lineCount === 1 ? [text] : balancedBreak(words, font, size);
            const widths = lines.map((line) => measurer.width(font, size, line));
            const width = Math.max(...widths);
            const height = lines.length * size;
            // Last resort: the smallest size in two lines at the safe box's
            // corner, past the box if the words must (never dropped).
            const spot =
              placeBox(candidate.area, obstacles, width, height, candidate.want(width, height)) ??
              (overlapping && size === MIN_TEXT_SIZE && (lineCount === 2 || words.length === 1)
                ? { x: safe.left, y: safe.top }
                : null);
            if (!spot) continue;
            const label = `${accentNoun(accent)} ${quote(text)}`;
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
            noteOverlap(
              extra.id,
              label,
              { left: place.x, right: place.x + width, top: place.y, bottom: place.y + height },
              span,
              "accent-face",
            );
            const item: OverlayItem = {
              id: extra.id,
              kind: "accent",
              start: startAnchorOf(accent.from, span.start),
              end: { word: accent.to, edge: "end" },
              words: ids,
              position: { x: place.x, y: place.y, align: "left" },
              size,
              ...(lines.length > 1 ? { break_after: lines[0]!.split(" ").length } : {}),
            };
            overlays.set(extra.id, item);
            shown.push({
              id: extra.id,
              what: label,
              start: span.start,
              end: span.end,
              box: {
                left: place.x,
                right: place.x + width,
                top: place.y,
                bottom: place.y + height,
              },
            });
            if (candidate !== candidates[0] && !overlapping) {
              record.push({
                item: extra.id,
                action: "moved",
                rule: "accent-spot",
                reason: `${label} sits ${candidate.name}: no room ${candidates[0]!.name}`,
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
            return;
          }
        }
      }
    }
  }

  // The written hook: in the upper part of the frame clear of the face,
  // inside the safe zone, else in the free part of the safe zone; in each
  // place it wraps to two lines, then shrinks to the floor, before it moves
  // on. The face is a preference: over it only when no place off it is free
  // (noted `covers-face`), then over other text as the last resort. The
  // accent's font, size and colour. Never dropped for its size:
  // when the floor does not fit its words in two lines it shrinks further,
  // until they do (`hook-size`).
  function placeHook(extra: Extra, span: { start: number; end: number }): void {
    const text = extra.hook!.text;
    const font = preset.accent.font;
    const fullSize = preset.fonts[font].size;
    const face = boundingBox(facesDuring(scene, span));
    const mid = (safe.top + safe.bottom) / 2;
    const candidates: Candidate[] = [
      {
        name: "in the upper part of the frame",
        area: { ...safe, bottom: face ? Math.max(safe.top, Math.min(mid, face.top - gap)) : mid },
        align: "center",
        want: (w, h) => ({ x: safeCx, y: safe.top + h / 2 }),
        maxLines: 2,
      },
      {
        name: "in the free part of the safe zone",
        area: safe,
        align: "center",
        want: (w, h) => ({ x: safeCx, y: safe.top + h / 2 }),
        maxLines: 2,
      },
    ];
    const obstacles = [...faceObstacles(span), ...textDuring(span), notch];
    const words = text.split(" ");
    const sizes = sizesFrom(fullSize, preset);
    const label = `the hook ${quote(text)}`;
    // Places the hook at one size and line break, clear of `avoid`; true once
    // it is placed. The forced spot ignores `avoid` (noted when it overlaps).
    const tryAt = (
      candidate: Candidate,
      size: number,
      lines: string[],
      avoid: Box[],
      forced?: { x: number; y: number },
    ): boolean => {
      const width = Math.max(...lines.map((line) => measurer.width(font, size, line)));
      const height = lines.length * size;
      const spot =
        forced ?? placeBox(candidate.area, avoid, width, height, candidate.want(width, height));
      if (!spot) return false;
      const notes = record.length;
      const place = keepReadable(
        extra.id,
        label,
        { ...spot, width, height },
        span,
        [preset.accent.color],
        readability.large,
        { area: candidate.area, obstacles: avoid },
        `no free place nearby reaches ${readability.large.min}:1`,
      );
      const contrastNotes = record.splice(notes);
      noteOverlap(
        extra.id,
        label,
        { left: place.x, right: place.x + width, top: place.y, bottom: place.y + height },
        span,
        "hook-face",
      );
      overlays.set(extra.id, {
        id: extra.id,
        kind: "hook",
        text,
        start: anchorAt(span.start, transcript.words),
        end: anchorAt(span.end, transcript.words),
        position: { x: place.x, y: place.y, align: "left" },
        size,
        ...(lines.length > 1 ? { break_after: lines[0]!.split(" ").length } : {}),
      });
      shown.push({
        id: extra.id,
        what: label,
        start: span.start,
        end: span.end,
        box: { left: place.x, right: place.x + width, top: place.y, bottom: place.y + height },
      });
      if (candidate !== candidates[0]) {
        record.push({
          item: extra.id,
          action: "moved",
          rule: "hook-spot",
          reason: `${label} sits ${candidate.name}: no room ${candidates[0]!.name}`,
        });
      }
      if (size < fullSize) {
        record.push({
          item: extra.id,
          action: "shrunk",
          rule: "hook-size",
          reason: `${label} set at ${size} px instead of ${fullSize} px to fit`,
        });
      }
      if (lines.length > 1) {
        record.push({
          item: extra.id,
          action: "wrapped",
          rule: "hook-wrap",
          reason: `${label} set in two lines to fit the frame`,
        });
      }
      record.push(...contrastNotes);
      return true;
    };
    for (const candidate of candidates) {
      for (const size of sizes) {
        for (const lineCount of words.length > 1 ? [1, 2] : [1]) {
          const lines = lineCount === 1 ? [text] : balancedBreak(words, font, size);
          if (tryAt(candidate, size, lines, obstacles)) return;
        }
      }
    }
    // Below the floor, never below the schema minimum: the smallest size its
    // words fit the safe zone in one or two lines, so the hook is never dropped
    // for its size.
    const maxWidth = safe.right - safe.left;
    const belowFloor: number[] = [];
    for (let size = sizes.at(-1)! - 1; size >= MIN_TEXT_SIZE; size -= 1) belowFloor.push(size);
    for (const size of belowFloor) {
      const oneLine = measurer.width(font, size, text) <= maxWidth;
      const lines = oneLine ? [text] : balancedBreak(words, font, size);
      if (lines.some((line) => measurer.width(font, size, line) > maxWidth)) continue;
      for (const candidate of candidates) {
        if (tryAt(candidate, size, lines, obstacles)) return;
      }
    }
    // Over the face but clear of the other text (noted `covers-face`): a hook
    // covers the face only when no size and place off it exists.
    const textOnly = [...textDuring(span), notch];
    for (const size of [...sizes, ...belowFloor]) {
      const options = words.length > 1 ? [[text], balancedBreak(words, font, size)] : [[text]];
      for (const lines of options) {
        if (lines.some((line) => measurer.width(font, size, line) > maxWidth)) continue;
        for (const candidate of candidates) {
          if (tryAt(candidate, size, lines, textOnly)) return;
        }
      }
    }
    // Nothing free at any size: the largest size whose words fit the safe box
    // in one or two lines, at the upper part's place, over the face and other
    // text if it must (noted). At the smallest size it is set whatever its width.
    const boxWidth = safe.right - safe.left;
    for (let size = fullSize; size >= MIN_TEXT_SIZE; size -= 1) {
      const options = words.length > 1 ? [[text], balancedBreak(words, font, size)] : [[text]];
      for (const lines of options) {
        const width = Math.max(...lines.map((line) => measurer.width(font, size, line)));
        if (width > boxWidth && size > MIN_TEXT_SIZE) continue;
        const forced = {
          x: Math.max(safe.left, Math.min(safeCx - width / 2, safe.right - width)),
          y: safe.top,
        };
        if (tryAt(candidates[0]!, size, lines, obstacles, forced)) return;
      }
    }
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
    // The person in front over its span: most of the word stays in view,
    // only its lower part behind the head.
    const faces = facesOver(headTrack, span.start, span.end);
    const maxCovered = 1 - spec.minVisible;
    const covered = (spot: { x: number; y: number }, width: number, size: number) =>
      bigWordCoveredShare(
        { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + size },
        faces,
        preset,
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
      const notes: EngineNote[] = [];
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
        spot: nearestSpot(box, preset),
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
    const span = accepted.find((entry) => entry.extra.id === extra.id)!;
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
    if (extra.kind === "accent" || extra.kind === "hook") continue;
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
      start: plan.start,
      end: plan.end,
      rank: 4000 + plan.index,
      big: false,
      words: range(plan.choice.from, plan.choice.to),
    })),
  ];

  return {
    picks,
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
