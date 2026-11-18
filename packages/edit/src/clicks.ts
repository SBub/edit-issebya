import type { Preset, SoundKey } from "./preset.ts";
import type { BehindItem, SoundItem } from "./schema.ts";
import { VARIANTS } from "./variants.ts";

// The id of the cue of a behind item: the sound that plays as it comes in.
const CUE_PREFIX = "click-";

// The variant entry whose `sound` knob the cue of each behind kind plays.
const CUE_ENTRY = {
  visual: VARIANTS["visual/card"],
  word: VARIANTS["bigword/behind"],
} as const satisfies Record<BehindItem["kind"], { sound: SoundKey }>;

// THE SOUND A CUE PLAYS: the cue of a behind item
// (`click-<the item's id>`) plays its entry's `sound` knob, a pop for a VISUAL
// and for a big word; every other sound item plays the sound it names. Read at
// every build, never stored: the sound track keeps saying `click`, so a
// version saved before the pop plays it too. The one list of a version's
// sounds asks here (`soundCues`, `sounds.ts`), and the builder (the export)
// and the preview's schedule both play that list, so they always agree.
export function cueSound(sound: SoundItem, behind: readonly BehindItem[] | undefined): SoundKey {
  if (sound.sound !== "click" || !sound.id.startsWith(CUE_PREFIX)) return sound.sound;
  const item = (behind ?? []).find((entry) => `${CUE_PREFIX}${entry.id}` === sound.id);
  return item ? CUE_ENTRY[item.kind].sound : sound.sound;
}

// THE CLICKS (owner decision 2026-11-04): the layout engine writes a new
// version's sound track. One `click` as each placed VISUAL and big word comes
// in, on the item's own start anchor (so it follows the item through every
// retime, and goes with it when the item is dropped), its end the item's end. Nothing else clicks. In time order; a click closer
// than the sound's gap to the one kept before it is left out, silently. Pure:
// `startOf` resolves an anchor to reel seconds.
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
