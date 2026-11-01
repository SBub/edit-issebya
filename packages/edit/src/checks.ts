import { type HeadTrack, faceBox } from "./head-track.ts";
import type { TextBox } from "./layout.ts";
import type { Preset } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import type { ResolvedItem } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

export type CheckRule = "safe-box" | "face" | "sound-gap" | "time-in-speech" | "out-of-reel";

// One failed layout rule; an empty list means every rule passes.
export interface Check {
  rule: CheckRule;
  item: string;
  reason: string;
}

const SLACK = 1e-6;

function px(n: number): string {
  return String(Math.round(n));
}

function label(box: TextBox): string {
  return `${box.kind} ${box.itemId} (${JSON.stringify(box.text)})`;
}

function overlaps(a: { left: number; right: number; top: number; bottom: number }, b: typeof a) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// The layout checks, in a stable order: text inside the safe box, captions
// clear of the face, sounds at least the preset's gap apart, time anchors
// outside speech, anchors inside the reel.
export function runChecks(
  edit: Edit,
  boxes: readonly TextBox[],
  resolved: ReadonlyMap<string, ResolvedItem>,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
): Check[] {
  const checks: Check[] = [];
  const { safe } = preset;

  for (const box of boxes) {
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    const edges: string[] = [];
    if (box.x < safe.left - SLACK) edges.push(`left edge ${px(box.x)} < ${safe.left}`);
    if (right > safe.right + SLACK) edges.push(`right edge ${px(right)} > ${safe.right}`);
    if (box.y < safe.top - SLACK) edges.push(`top edge ${px(box.y)} < ${safe.top}`);
    if (bottom > safe.bottom + SLACK) edges.push(`bottom edge ${px(bottom)} > ${safe.bottom}`);
    if (edges.length > 0) {
      checks.push({
        rule: "safe-box",
        item: box.itemId,
        reason: `${label(box)} runs past the safe box: ${edges.join(", ")}`,
      });
    }
  }

  for (const box of boxes) {
    if (box.kind !== "caption") continue;
    const face = faceBox(headTrack, box.start, box.end, { left: 0, right: 0 });
    if (!face) continue;
    const rect = { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
    if (overlaps(rect, face)) {
      checks.push({
        rule: "face",
        item: box.itemId,
        reason: `${label(box)} covers the face (x ${px(face.left)} to ${px(face.right)}, y ${px(face.top)} to ${px(face.bottom)})`,
      });
    }
  }

  const hits = edit.tracks.sounds
    .map((sound) => ({ sound, at: resolved.get(sound.id)!.start }))
    .sort((a, b) => a.at - b.at || (a.sound.id < b.sound.id ? -1 : 1));
  for (let index = 1; index < hits.length; index += 1) {
    const before = hits[index - 1]!;
    const hit = hits[index]!;
    const gap = preset.sounds[hit.sound.sound].minGapSeconds;
    if (hit.at - before.at < gap - SLACK) {
      checks.push({
        rule: "sound-gap",
        item: hit.sound.id,
        reason: `sound ${hit.sound.id} is ${(hit.at - before.at).toFixed(3)} s after ${before.sound.id}, under ${gap} s`,
      });
    }
  }

  const { tracks } = edit;
  const items = [
    ...tracks.footage,
    ...tracks.cutout,
    ...tracks.transitions,
    ...tracks.captions,
    ...tracks.overlays,
    ...tracks.sounds,
  ];
  for (const item of items) {
    const anchors: Anchor[] = [item.start, item.end];
    for (const anchor of anchors) {
      if (!("time" in anchor)) continue;
      const word = transcript.words.find((w) => anchor.time > w.start && anchor.time < w.end);
      if (word) {
        checks.push({
          rule: "time-in-speech",
          item: item.id,
          reason: `${item.id} is anchored at ${anchor.time.toFixed(3)} s, inside the word ${word.id} (${JSON.stringify(word.text)}); anchor it to the word`,
        });
      }
    }
  }

  for (const item of items) {
    if (resolved.get(item.id)?.clamped) {
      checks.push({
        rule: "out-of-reel",
        item: item.id,
        reason: `${item.id} resolves outside the reel (0 to ${edit.duration.toFixed(3)} s) and was clamped`,
      });
    }
  }

  return checks;
}
