import type { Anchor, Item } from "./schema.ts";
import type { Word } from "./transcript.ts";

// Seconds rounded to the millisecond.
export function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// An anchor's time in seconds: a word's start or end (the item's start
// defaults to the word's start, its end to the word's end) plus the offset,
// or a fixed time where nobody speaks. Looked up on every build, so an item
// follows its word through a retime.
function resolve(anchor: Anchor, words: Map<string, Word>, defaultEdge: "start" | "end"): number {
  if ("at" in anchor) return ms(anchor.at);
  const word = words.get(anchor.word);
  if (!word) throw new Error(`unknown word ${anchor.word}`);
  const edge = anchor.edge ?? defaultEdge;
  return ms((edge === "start" ? word.start : word.end) + (anchor.offset ?? 0));
}

export function itemTimes(item: Item, words: Map<string, Word>): { start: number; end: number } {
  return { start: resolve(item.start, words, "start"), end: resolve(item.end, words, "end") };
}
