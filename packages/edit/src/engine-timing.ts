import type { EngineInput } from "./engine-input.ts";
import type { EngineComponent, PlaceNote, RecordNote } from "./engine-note.ts";
import { resolveAnchor } from "./timeline.ts";
import { wordsText } from "./glossary.ts";
import { type Preset, SHOWN_FLOOR_SECONDS } from "./preset.ts";
import type { CaptionItem } from "./schema.ts";
import { type Transcript, type Word } from "./transcript.ts";

// THE TIMING (`specs/layout-engine.md`, "Timing first"): each element's span
// from its words and its entry's timing option, the caption groups, the
// same-text pass and the helpers the timing options share. Nothing here places
// anything; the placer (`engine-place.ts`) and the loop (`engine.ts`) read the
// spans.

export const SLACK = 1e-6;

export function ms(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

export function at(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

export function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 37)}...` : text);
}

export function during(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end - SLACK && b.start < a.end - SLACK;
}

interface Unit {
  index: number;
  caption: CaptionItem;
  text: string;
  start: number;
  lastWord: Word;
}

export interface CaptionBlock {
  groups: Unit[][];
  start: number;
  end: number;
}

// The current captions as groups (one set of words on screen: consecutive
// captions ending on the same anchor), re-timed: a group's out-fade runs over
// `caption.outSeconds` after its last word's end (the span ends one fade past
// the word, so the word is at full opacity while spoken), held so its last
// caption shows at least the preset's minimum, never past the next group's
// start; a last caption that cannot show that long joins the next group.
export function captionGroups(
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
    const fade = preset.caption.outSeconds;
    const end = ms(
      Math.min(next, duration, Math.max(lastWord.end + fade, group.at(-1)!.start + min)),
    );
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

// A pick with no length at all (its words take no time) shows the shown
// floor from its start, earlier where the reel ends: the floor only guards
// against a zero-length pick, it is no minimum.
export function floorSpan(
  start: number,
  end: number,
  duration: number,
): { start: number; end: number } {
  if (end - start > SLACK) return { start, end };
  const from = ms(Math.max(0, Math.min(start, duration - SHOWN_FLOOR_SECONDS)));
  return { start: from, end: ms(Math.min(duration, from + SHOWN_FLOOR_SECONDS)) };
}

// A pick over hidden footage: the next visible moment after the cut (from its
// end, as long as the pick lasts, up to the next cut), else the last one before
// it. Null when neither holds the shown floor.
export function visibleSpan(
  span: { start: number; end: number },
  hidden: readonly { start: number; end: number }[],
  duration: number,
): { start: number; end: number } | null {
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
export function ownSpan(
  startAt: number,
  lastEnd: number,
  min: number,
  max: number,
  duration: number,
): { start: number; end: number } {
  const end = ms(Math.min(duration, Math.max(lastEnd, startAt + min), startAt + max));
  return { start: ms(startAt), end };
}

// A text pick as placed: its answer reference (`accents[0]`, `big_words[1]`,
// ...), what a note calls it, its span, its place in the answer order (the
// same-text tie-break), whether it is a big word, and the word ids it shows, in
// transcript order.
export interface TextPick {
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
export function sameTextPass(
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
