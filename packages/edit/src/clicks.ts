import type { Preset } from "./preset.ts";
import type { BehindItem, SoundItem } from "./schema.ts";

// THE CLICKS (owner decision 2026-11-04): the layout engine writes a new
// version's sound track. One `click` as each placed photo (behind or in
// front of the speaker) and big word comes in, on the item's own start
// anchor (so it follows the item through every retime, and goes with it when
// the item is dropped), its end the item's end. Nothing else clicks. In time
// order; a click closer than the sound's gap to the one kept before it is
// left out, silently. Pure: `startOf` resolves an anchor to reel seconds.
export function clicksFor(
  items: readonly BehindItem[],
  startOf: (item: BehindItem) => number,
  preset: Preset,
): SoundItem[] {
  const { minGapSeconds } = preset.sounds.click;
  const timed = items
    .map((item) => ({ item, at: startOf(item) }))
    .sort((a, b) => a.at - b.at || (a.item.id < b.item.id ? -1 : 1));
  const out: SoundItem[] = [];
  let last = -Infinity;
  for (const { item, at } of timed) {
    if (at - last < minGapSeconds - 1e-6) continue;
    last = at;
    out.push({ id: `click-${item.id}`, sound: "click", start: item.start, end: item.end });
  }
  return out;
}
