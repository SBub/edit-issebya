import { type BigWordBox, bigWordCoveredShare, boxFaceShare, photoBox } from "./behind.ts";
import { type Box, type HeadTrack, facesOver } from "./head-track.ts";
import type { TextBox } from "./layout.ts";
import { PLATFORM_BUTTONS, PLATFORM_SAFE, type Preset, cleanWord, intersectBox } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import type { ResolvedItem } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

export type CheckRule =
  | "safe-box"
  | "frame"
  | "behind-face"
  | "behind-caption"
  | "face"
  | "text-overlap"
  | "timing"
  | "big-word-timing"
  | "big-word-hidden"
  | "photo-hidden"
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

// The box with each edge moved `by` inwards, so touching edges do not count.
function shrink(box: Box, by: number): Box {
  return {
    left: box.left + by,
    right: box.right - by,
    top: box.top + by,
    bottom: box.bottom - by,
  };
}

function overlaps(a: { left: number; right: number; top: number; bottom: number }, b: typeof a) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// The layout checks, in a stable order: text inside the safe box, never past
// the platform guard nor over its button column whatever the preset says, big words
// behind the speaker inside the frame (they cross the safe box by design),
// photos behind the speaker not taken over by the face (one in front never
// over it) and with no caption or accent over them, a photo the engine set
// behind the speaker mostly in view, captions clear of the face, no text on other text shown
// at the same time, captions and accents at least their minimum on screen,
// the big word never more than the lead before its word is said and mostly
// in view (not behind the person), sounds at least the preset's
// gap apart, time anchors outside speech, anchors inside the reel. The face is
// the robust one (`facesOver`) the layout engine places around, so the checks
// never fail on the engine's output: they are its final guard. `boxes` holds
// the captions shown in their place (never those a transition shows as its
// levels), `levels` the transitions' text levels, checked for the safe box
// and overlaps only (the engine records a level over the face).
export function runChecks(
  edit: Edit,
  boxes: readonly TextBox[],
  resolved: ReadonlyMap<string, ResolvedItem>,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  bigWords: readonly BigWordBox[] = [],
  // The transitions' text levels: inside the safe box and on no other text.
  levels: readonly TextBox[] = [],
): Check[] {
  const checks: Check[] = [];
  const safe = intersectBox(preset.safe, PLATFORM_SAFE);

  for (const box of [...boxes, ...levels]) {
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
    } else if (
      overlaps({ left: box.x, right, top: box.y, bottom }, shrink(PLATFORM_BUTTONS, SLACK))
    ) {
      const { left, top } = PLATFORM_BUTTONS;
      checks.push({
        rule: "safe-box",
        item: box.itemId,
        reason: `${label(box)} runs into the platform button column below y ${top}: right edge ${px(right)} > ${left}`,
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

  // The pictures: a library photo or a visual frame, checked the same way.
  const photos = (edit.tracks.behind ?? []).flatMap((item) =>
    item.kind === "photo" || item.kind === "visual" ? [{ item, span: resolved.get(item.id)! }] : [],
  );
  // Where it is, in plain words: its spot (behind) or `in front`.
  const where = (item: (typeof photos)[number]["item"]) =>
    item.layer === "front" ? "in front" : `in the ${item.spot} spot`;
  for (const { item, span } of photos) {
    const faces = facesOver(headTrack, span.start, span.end);
    const box = photoBox(item, preset);
    if (item.layer === "front") {
      // In front of the speaker it would hide the face: never over it.
      if (faces.some((face) => overlaps(shrink(box, SLACK), face))) {
        checks.push({
          rule: "behind-face",
          item: item.id,
          reason: `photo ${item.id} in front covers the face; a photo in front stays clear of it`,
        });
      }
      continue;
    }
    const share = Math.max(0, ...faces.map((face) => boxFaceShare(box, face)));
    const max = preset.behind.maxFaceShare;
    if (share > max + SLACK) {
      checks.push({
        rule: "behind-face",
        item: item.id,
        reason: `photo ${item.id} ${where(item)}: the face covers ${Math.round(share * 100)}% of it, more than ${Math.round(max * 100)}%; pick a spot clear of the head`,
      });
    }
  }
  for (const { item, span } of photos) {
    const spot = photoBox(item, preset);
    for (const box of boxes) {
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
        reason: `photo ${item.id} ${where(item)} sits under ${box.kind} ${box.itemId} (${JSON.stringify(box.text)}); pick another spot`,
      });
    }
  }
  // A photo the engine set behind the speaker (with its own box) mostly in
  // view: the person covers at most `1 - photo.minVisible` of its height in
  // any column. A version saved before it (a spot only) is not checked.
  const photoCovered = 1 - preset.behind.photo.minVisible;
  for (const { item, span } of photos) {
    if (item.layer === "front" || !item.box) continue;
    const share = bigWordCoveredShare(
      photoBox(item, preset),
      facesOver(headTrack, span.start, span.end),
      preset,
    );
    if (share > photoCovered + SLACK) {
      checks.push({
        rule: "photo-hidden",
        item: item.id,
        reason: `photo ${item.id} behind you: the person covers ${Math.round(share * 100)}% of its height, more than ${Math.round(photoCovered * 100)}%; move it out from behind the person or in front`,
      });
    }
  }

  for (const box of boxes) {
    if (box.kind !== "caption") continue;
    const rect = { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
    const face = facesOver(headTrack, box.start, box.end).find((candidate) =>
      overlaps(shrink(rect, SLACK), candidate),
    );
    if (face) {
      checks.push({
        rule: "face",
        item: box.itemId,
        reason: `${label(box)} covers the face (x ${px(face.left)} to ${px(face.right)}, y ${px(face.top)} to ${px(face.bottom)})`,
      });
    }
  }

  const texts = [
    ...[...boxes, ...levels].map((box) => ({
      id: box.itemId,
      what: label(box),
      start: box.start,
      end: box.end,
      rect: { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height },
    })),
    ...bigWords.map((word) => ({
      id: word.itemId,
      what: `big word ${word.itemId} (${JSON.stringify(word.text)})`,
      ...resolved.get(word.itemId)!,
      rect: { left: word.x, right: word.x + word.width, top: word.y, bottom: word.y + word.height },
    })),
  ];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index]!;
    for (const other of texts.slice(0, index)) {
      if (!(text.start < other.end - SLACK && other.start < text.end - SLACK)) continue;
      if (!overlaps(shrink(text.rect, SLACK), other.rect)) continue;
      checks.push({
        rule: "text-overlap",
        item: text.id,
        reason: `${text.what} sits on ${other.what} while both are shown`,
      });
    }
  }

  for (const box of boxes) {
    const min = box.kind === "caption" ? preset.caption.minSeconds : preset.accent.minSeconds;
    const span = resolved.get(box.itemId)!;
    if (span.end - span.start < min - SLACK) {
      checks.push({
        rule: "timing",
        item: box.itemId,
        reason: `${label(box)} shows ${(span.end - span.start).toFixed(3)} s, under ${min} s`,
      });
    }
  }

  for (const item of edit.tracks.behind ?? []) {
    if (item.kind !== "word") continue;
    const { start } = resolved.get(item.id)!;
    const said = transcript.words
      .filter((word) => cleanWord(word.text, preset).toLowerCase() === item.text.toLowerCase())
      .sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0];
    const lead = preset.accent.leadSeconds;
    if (said && start < said.start - lead - SLACK) {
      checks.push({
        rule: "big-word-timing",
        item: item.id,
        reason: `big word ${item.id} (${JSON.stringify(item.text)}) shows at ${start.toFixed(3)} s, more than ${lead} s before ${said.id} is said at ${said.start.toFixed(3)} s`,
      });
    }
  }

  // Most of a big word in view: the person (the robust faces over its span
  // and the body under them) covers at most `1 - minVisible` of its height
  // anywhere, so only its lower part goes behind the head.
  const maxCovered = 1 - preset.behind.word.minVisible;
  for (const word of bigWords) {
    const span = resolved.get(word.itemId)!;
    const box = {
      left: word.x,
      right: word.x + word.width,
      top: word.y,
      bottom: word.y + word.height,
    };
    const share = bigWordCoveredShare(box, facesOver(headTrack, span.start, span.end), preset);
    if (share > maxCovered + SLACK) {
      checks.push({
        rule: "big-word-hidden",
        item: word.itemId,
        reason: `big word ${word.itemId} (${JSON.stringify(word.text)}): the person covers ${Math.round(share * 100)}% of its height, more than ${Math.round(maxCovered * 100)}%; move it up out from behind the head`,
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
