import { type BigWordBox, spotBox, spotFaceShare } from "./behind.ts";
import { type HeadTrack, faceBox } from "./head-track.ts";
import type { TextBox } from "./layout.ts";
import { MIN_LARGE_TEXT_CONTRAST, contrastRatio } from "./contrast.ts";
import { PLATFORM_SAFE, type Preset, intersectBox } from "./preset.ts";
import { type Anchor, type Edit, isPhraseTransition } from "./schema.ts";
import { type ResolvedItem, phraseWords } from "./timeline.ts";
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
  | "glossary"
  | "transition-length"
  | "transition-density"
  | "transition-behind"
  | "transition-overlap"
  | "transition-area"
  | "transition-fit"
  | "transition-accent"
  | "contrast";

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

// The layout checks, in a stable order: text inside the safe box, never past
// the platform guard whatever the preset says, big words
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
  const safe = intersectBox(preset.safe, PLATFORM_SAFE);

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
      // A transition's levels never show with a behind item (transition-behind).
      if (box.kind !== "caption" || box.transitionId !== undefined) continue;
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
    // A transition's levels cover the footage by design.
    if (box.kind !== "caption" || box.transitionId !== undefined) continue;
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
    // A phrase transition has no anchors (its span comes from its words).
    if (!("start" in item)) continue;
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

  checks.push(...transitionChecks(edit, boxes, resolved, transcript, preset));
  return checks;
}

const LEVEL_NAMES: Record<string, string> = {
  number: "number",
  lead: "lead-in",
  key: "key phrase",
};

// The phrase transitions' rules (stored timed transitions keep only the
// checks above, so old versions report what they always did): long enough,
// about one per `densitySeconds`, never with a behind item or another
// transition, a text area inside the platform guard, levels that fit it, no
// accent on a word of the phrase, and the text roles readable on the
// background role.
function transitionChecks(
  edit: Edit,
  boxes: readonly TextBox[],
  resolved: ReadonlyMap<string, ResolvedItem>,
  transcript: Transcript,
  preset: Preset,
): Check[] {
  const checks: Check[] = [];
  const phrases = edit.tracks.transitions.filter(isPhraseTransition);
  if (phrases.length === 0) return checks;
  const rules = preset.transitionRules;
  const spanOf = (id: string) => resolved.get(id)!;

  for (const item of phrases) {
    const { start, end } = spanOf(item.id);
    if (end - start < rules.minSeconds - SLACK) {
      checks.push({
        rule: "transition-length",
        item: item.id,
        reason: `transition ${item.id} lasts ${(end - start).toFixed(2)} s, at least ${rules.minSeconds} s: cover more words or pick a longer phrase`,
      });
    }
  }

  const allowed = Math.max(1, Math.ceil(edit.duration / rules.densitySeconds - SLACK));
  if (edit.tracks.transitions.length > allowed) {
    const extra = edit.tracks.transitions[allowed]!;
    checks.push({
      rule: "transition-density",
      item: extra.id,
      reason: `${edit.tracks.transitions.length} transitions in a ${edit.duration.toFixed(1)} s reel, at most ${allowed} (one per ${rules.densitySeconds} s): drop ${edit.tracks.transitions.length - allowed === 1 ? "one" : edit.tracks.transitions.length - allowed}`,
    });
  }

  const crosses = (a: { start: number; end: number }, b: typeof a) =>
    a.start < b.end - SLACK && b.start < a.end - SLACK;
  for (const item of phrases) {
    const span = spanOf(item.id);
    for (const behind of edit.tracks.behind ?? []) {
      if (!crosses(span, spanOf(behind.id))) continue;
      checks.push({
        rule: "transition-behind",
        item: item.id,
        reason: `transition ${item.id} overlaps behind ${behind.id}; a transition and a behind item never show together`,
      });
    }
  }

  const all = edit.tracks.transitions;
  for (const [index, item] of all.entries()) {
    for (const other of all.slice(index + 1)) {
      if (!isPhraseTransition(item) && !isPhraseTransition(other)) continue;
      if (!crosses(spanOf(item.id), spanOf(other.id))) continue;
      checks.push({
        rule: "transition-overlap",
        item: other.id,
        reason: `transition ${other.id} overlaps transition ${item.id}; one transition at a time`,
      });
    }
  }

  const safe = intersectBox(preset.safe, PLATFORM_SAFE);
  for (const item of phrases) {
    const { text } = preset.transitions[item.type];
    const edges: string[] = [];
    if (text.left < safe.left) edges.push(`left edge ${px(text.left)} < ${safe.left}`);
    if (text.right > safe.right) edges.push(`right edge ${px(text.right)} > ${safe.right}`);
    if (text.top < safe.top) edges.push(`top edge ${px(text.top)} < ${safe.top}`);
    if (text.bottom > safe.bottom) edges.push(`bottom edge ${px(text.bottom)} > ${safe.bottom}`);
    if (edges.length === 0) continue;
    checks.push({
      rule: "transition-area",
      item: item.id,
      reason: `transition ${item.id}: the ${item.type} text area runs past the safe box: ${edges.join(", ")}`,
    });
  }

  const reported = new Set<string>();
  for (const box of boxes) {
    if (box.transitionId === undefined || reported.has(box.itemId)) continue;
    const item = phrases.find((phrase) => phrase.id === box.transitionId);
    if (!item) continue;
    const { text } = preset.transitions[item.type];
    const inside =
      box.x >= text.left - SLACK &&
      box.x + box.width <= text.right + SLACK &&
      box.y >= text.top - SLACK &&
      box.y + box.height <= text.bottom + SLACK;
    if (inside) continue;
    reported.add(box.itemId);
    const level = LEVEL_NAMES[box.itemId.slice(item.id.length + 1)] ?? "text";
    checks.push({
      rule: "transition-fit",
      item: item.id,
      reason: `the ${level} of ${item.id} does not fit the ${item.type}'s text area: pick fewer words${item.type === "dim" ? "" : " or use dim"}`,
    });
  }

  for (const item of phrases) {
    const { lead, key } = phraseWords(item, transcript);
    const words = new Set([...lead, ...key].map((word) => word.id));
    for (const overlay of edit.tracks.overlays) {
      if (overlay.id === "title" || !overlay.words?.some((word) => words.has(word))) continue;
      checks.push({
        rule: "transition-accent",
        item: overlay.id,
        reason: `accent ${overlay.id} is on a word of transition ${item.id}, which already sets its key phrase in accent text`,
      });
    }
  }

  const { accentText, captionText, background } = preset.roles;
  for (const item of phrases) {
    for (const [name, role] of [
      ["caption text", captionText],
      ["accent text", accentText],
    ] as const) {
      const ratio = contrastRatio(role.color, background.color);
      if (ratio >= MIN_LARGE_TEXT_CONTRAST) continue;
      checks.push({
        rule: "contrast",
        item: item.id,
        reason: `transition ${item.id}: ${name} ${role.color} on background ${background.color} has contrast ${ratio.toFixed(1)}, under ${MIN_LARGE_TEXT_CONTRAST}`,
      });
    }
  }

  return checks;
}
