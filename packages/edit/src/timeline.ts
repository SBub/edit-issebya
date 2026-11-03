import { ISSEBYA_PRESET, type Preset } from "./preset.ts";
import type { Anchor, Edit, PhraseTransitionItem } from "./schema.ts";
import type { Transcript, Word } from "./transcript.ts";

export interface Span {
  start: number;
  end: number;
}

export interface ResolvedItem extends Span {
  // An anchor fell before 0 or after the reel's end and was clamped.
  clamped: boolean;
}

function ms(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

// One anchor in seconds: a word's edge plus its offset, a time as is, the
// reel's start (0) or end (the edit's duration). Unclamped, to the millisecond.
export function resolveAnchor(
  anchor: Anchor,
  words: ReadonlyMap<string, Word>,
  duration: number,
): number {
  if ("time" in anchor) return ms(anchor.time);
  if ("reel" in anchor) return anchor.reel === "start" ? 0 : ms(duration);
  const word = words.get(anchor.word);
  if (!word) throw new Error(`unknown word ${anchor.word}`);
  const edge = anchor.edge === "end" ? word.end : word.start;
  return ms(edge + (anchor.offset ?? 0));
}

function wordMap(transcript: Transcript): Map<string, Word> {
  return new Map(transcript.words.map((word) => [word.id, word]));
}

// A phrase transition's words in transcript order: the lead-in (empty when
// `key_from` is unset or is the first word) and the key phrase.
export function phraseWords(
  item: Pick<PhraseTransitionItem, "from" | "to" | "key_from">,
  transcript: Transcript,
): { lead: Word[]; key: Word[] } {
  const index = (id: string) => transcript.words.findIndex((word) => word.id === id);
  const from = index(item.from);
  const to = index(item.to);
  const keyFrom = item.key_from === undefined ? from : index(item.key_from);
  return {
    lead: transcript.words.slice(from, keyFrom),
    key: transcript.words.slice(keyFrom, to + 1),
  };
}

// The length of a phrase transition's entrance and exit: its own, else the
// library's.
export function phraseMotion(item: PhraseTransitionItem, preset: Preset): number {
  return item.motion_seconds ?? preset.transitions[item.type].seconds;
}

// A phrase transition's span, unclamped: its entrance ends as the first word
// starts; it leaves when the next word starts, at most the hold after the
// last word, never after the reel's end, and never before its last word ends
// unless the reel ends first.
function phraseSpan(
  item: PhraseTransitionItem,
  transcript: Transcript,
  duration: number,
  preset: Preset,
): Span {
  const at = (id: string) => transcript.words.findIndex((word) => word.id === id);
  const first = transcript.words[at(item.from)];
  const lastIndex = at(item.to);
  const last = transcript.words[lastIndex];
  if (!first || !last) throw new Error(`unknown word in transition ${item.id}`);
  const next = transcript.words[lastIndex + 1];
  const hold = item.hold_seconds ?? preset.transitionRules.maxHoldSeconds;
  const end = Math.min(next ? next.start : Infinity, last.end + hold, duration);
  return {
    start: ms(first.start - phraseMotion(item, preset)),
    end: ms(Math.max(end, Math.min(last.end, duration))),
  };
}

// Every item's span in seconds, by id, in the edit's order. Every build calls
// this, so items follow their words when the transcript is re-timed; a phrase
// transition's span is derived from its words and the preset.
export function resolveTimeline(
  edit: Edit,
  transcript: Transcript,
  preset: Preset = ISSEBYA_PRESET,
): Map<string, ResolvedItem> {
  const words = wordMap(transcript);
  const out = new Map<string, ResolvedItem>();
  const clamp = (t: number) => Math.min(Math.max(t, 0), ms(edit.duration));
  const set = (id: string, start: number, end: number) => {
    const clampedStart = clamp(start);
    const clampedEnd = clamp(end);
    out.set(id, {
      start: clampedStart,
      end: Math.max(clampedEnd, clampedStart),
      clamped: clampedStart !== start || clampedEnd !== end,
    });
  };
  const add = (item: { id: string; start: Anchor; end: Anchor }) => {
    set(
      item.id,
      resolveAnchor(item.start, words, edit.duration),
      resolveAnchor(item.end, words, edit.duration),
    );
  };
  const { tracks } = edit;
  for (const item of [...tracks.footage, ...(tracks.cutout ?? [])]) add(item);
  for (const item of tracks.transitions) {
    if ("from" in item) {
      const { start, end } = phraseSpan(item, transcript, edit.duration, preset);
      set(item.id, start, end);
    } else {
      add(item);
    }
  }
  for (const item of [
    ...tracks.captions,
    ...tracks.overlays,
    ...tracks.sounds,
    ...(tracks.behind ?? []),
  ]) {
    add(item);
  }
  return out;
}

// A clip's hidden ranges in seconds.
export function resolveSpans(
  spans: readonly { start: Anchor; end: Anchor }[] | undefined,
  edit: Edit,
  transcript: Transcript,
): Span[] {
  const words = wordMap(transcript);
  return (spans ?? []).map((span) => ({
    start: resolveAnchor(span.start, words, edit.duration),
    end: resolveAnchor(span.end, words, edit.duration),
  }));
}
