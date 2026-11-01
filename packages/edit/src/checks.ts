import { type LayoutEntry, type ResolvedItem, faceBox } from "./layout.ts";
import type { Preset } from "./preset.ts";
import type { HeadTrack } from "./transcript.ts";

export interface CheckResult {
  ok: boolean;
  // Sorted, so the same edit always gives the same list.
  reasons: string[];
}

function byStartThenId(a: ResolvedItem, b: ResolvedItem): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// What the schema cannot see because it depends on text widths or the head:
// every text box inside the safe box (`safe-box`), no caption over the face
// for its time (`face`), and sound hits at least the preset's gap apart
// (`sound-gap`).
export function runChecks(
  layout: LayoutEntry[],
  resolved: ResolvedItem[],
  headTrack: HeadTrack,
  preset: Preset,
): CheckResult {
  const reasons: string[] = [];
  const { safe } = preset;
  for (const entry of layout) {
    const edges: [string, boolean][] = [
      ["left", entry.x < safe.left],
      ["right", entry.x + entry.width > safe.right],
      ["top", entry.y < safe.top],
      ["bottom", entry.y + entry.height > safe.bottom],
    ];
    for (const [edge, outside] of edges) {
      if (outside) reasons.push(`${entry.id}: outside the safe box (${edge})`);
    }
    if (entry.track !== "captions") continue;
    const face = faceBox(headTrack, entry.start, entry.end, preset);
    if (
      face &&
      entry.x < face.right &&
      face.left < entry.x + entry.width &&
      entry.y < face.bottom &&
      face.top < entry.y + entry.height
    ) {
      reasons.push(`${entry.id}: covers the face`);
    }
  }
  // Whole milliseconds, so 0.25 s apart passes and 0.249 s does not.
  const gap = Math.round(preset.minSoundGap * 1000);
  const sounds = resolved.filter((item) => item.track === "sounds").sort(byStartThenId);
  for (let index = 1; index < sounds.length; index += 1) {
    const previous = sounds[index - 1]!;
    const current = sounds[index]!;
    if (Math.round(current.start * 1000) - Math.round(previous.start * 1000) < gap) {
      reasons.push(`${current.id}: within ${preset.minSoundGap} s of ${previous.id}`);
    }
  }
  reasons.sort();
  return { ok: reasons.length === 0, reasons };
}
