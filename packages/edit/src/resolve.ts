import { itemTimes } from "./anchors.ts";
import type { ResolvedItem } from "./layout.ts";
import { type Edit, type Item, TRACKS } from "./schema.ts";
import { type Transcript, wordIndex } from "./transcript.ts";

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Every item with its times, sorted by start then id.
export function resolveAll(edit: Edit, transcript: Transcript): ResolvedItem[] {
  const words = wordIndex(transcript);
  const resolved: ResolvedItem[] = [];
  for (const track of TRACKS) {
    const items: Item[] = edit.tracks[track];
    for (const item of items)
      resolved.push({ id: item.id, track, item, ...itemTimes(item, words) });
  }
  return resolved.sort((a, b) => a.start - b.start || compareIds(a.id, b.id));
}
