import { type BigWordBox, spotBox, spotFaceShare } from "./behind.ts";
import { type HeadTrack, faceBox } from "./head-track.ts";
import type { TextBox } from "./layout.ts";
import type { Preset } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import type { ResolvedItem } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

export type CheckRule =
  | "safe-box"
  | "frame"
  | "behind-face"
  | "behind-caption"
  | "face"
  | "sound-gap"
  | "time-in-speech"
  | "out-of-reel"
  | "glossary";

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

// The layout checks, in a stable order: text inside the safe box, big words
// behind the speaker inside the frame (they cross the safe box by design),
// photos behind the speaker not taken over by the face and with no caption
// over them, captions clear of the face, sounds at least the preset's gap apart, time
// anchors outside speech, anchors inside the reel.
export function runChecks(
  edit: Edit,
  boxes: readonly TextBox[],
  resolved: ReadonlyMap<string, ResolvedItem>,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  bigWords: readonly BigWordBox[] = [],
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

  for (const word of bigWords) {
    const right = word.x + word.width;
    const bottom = word.y + word.height;
    const { width, height } = preset.frame;
    const edges: string[] = [];
    if (word.x < -SLACK) edges.push(`left edge ${px(word.x)} < 0`);
    if (right > width + SLACK) edges.push(`right edge ${px(right)} > ${width}`);
    if (word.y < -SLACK) edges.push(`top edge ${px(word.y)} < 0`);
    if (bottom > height + SLACK) edges.push(`bottom edge ${px(bottom)} > ${height}`);
    if (edges.length > 0) {
      checks.push({
        rule: "frame",
        item: word.itemId,
        reason: `big word ${word.itemId} (${JSON.stringify(word.text)}) leaves the frame: ${edges.join(", ")}`,
      });
    }
  }

  const photos = (edit.tracks.behind ?? []).flatMap((item) =>
    item.kind === "photo" ? [{ item, span: resolved.get(item.id)! }] : [],
  );
  for (const { item, span } of photos) {
    const face = faceBox(headTrack, span.start, span.end, { left: 0, right: 0 });
    const share = spotFaceShare(item.spot, face, preset);
    const max = preset.behind.maxFaceShare;
    if (share > max + SLACK) {
      checks.push({
        rule: "behind-face",
        item: item.id,
        reason: `photo ${item.id} in the ${item.spot} spot: the face covers ${Math.round(share * 100)}% of it, more than ${Math.round(max * 100)}%; pick a spot clear of the head`,
      });
    }
  }
  for (const { item, span } of photos) {
    const spot = spotBox(item.spot, preset);
    for (const box of boxes) {
      if (box.kind !== "caption") continue;
      if (!(box.start < span.end - SLACK && span.start < box.end - SLACK)) continue;
      const rect = {
        left: box.x,
        right: box.x + box.width,
        top: box.y,
        bottom: box.y + box.height,
      };
      if (!overlaps(rect, spot)) continue;
      checks.push({
        rule: "behind-caption",
        item: item.id,
        reason: `photo ${item.id} in the ${item.spot} spot sits under caption ${box.itemId} (${JSON.stringify(box.text)}); pick another spot`,
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
    ...(tracks.cutout ?? []),
    ...tracks.transitions,
    ...tracks.captions,
    ...tracks.overlays,
    ...tracks.sounds,
    ...(tracks.behind ?? []),
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
