import type { Anchor, Edit } from "./schema.ts";
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

// Every item's span in seconds, by id, in the edit's order. Every build calls
// this, so items follow their words when the transcript is re-timed.
export function resolveTimeline(edit: Edit, transcript: Transcript): Map<string, ResolvedItem> {
  const words = wordMap(transcript);
  const out = new Map<string, ResolvedItem>();
  const clamp = (t: number) => Math.min(Math.max(t, 0), ms(edit.duration));
  const add = (item: { id: string; start: Anchor; end: Anchor }) => {
    const start = resolveAnchor(item.start, words, edit.duration);
    const end = resolveAnchor(item.end, words, edit.duration);
    const clampedStart = clamp(start);
    const clampedEnd = clamp(end);
    out.set(item.id, {
      start: clampedStart,
      end: Math.max(clampedEnd, clampedStart),
      clamped: clampedStart !== start || clampedEnd !== end,
    });
  };
  const { tracks } = edit;
  for (const item of [
    ...tracks.footage,
    ...tracks.cutout,
    ...tracks.transitions,
    ...tracks.captions,
    ...tracks.overlays,
    ...tracks.sounds,
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
