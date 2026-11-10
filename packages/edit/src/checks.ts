import { type BigWordBox, needsCutout, visualBox } from "./behind.ts";
import type { EngineNote } from "./engine-note.ts";
import type { TextBox } from "./engine-space.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import { type Box, type HeadTrack, facesOver } from "./head-track.ts";
import { type Preset, SHOWN_FLOOR_SECONDS, cleanWord } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import { timingOf, VARIANTS } from "./variants.ts";
import type { ResolvedItem } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

export type CheckRule =
  | "safe-box"
  | "face"
  | "text-overlap"
  | "card-overlap"
  | "same-text"
  | "timing"
  | "big-word-timing"
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

function wordLabel(word: BigWordBox): string {
  return `big word ${word.itemId} (${JSON.stringify(word.text)})`;
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

// The layout checks, in a stable order: text inside the safe zone S (the
// platform guard, never past it nor over its button column; the big words
// behind the speaker too, decision 2 of `specs/layout-engine.md`), captions
// clear of the face, no two texts on screen at a shared
// moment overlapping (`text-overlap`), captions and accents at least their
// minimum on screen (a pick at least the shown floor), the big word never more
// than the lead before its word is said, sounds at least the preset's gap
// apart, time anchors outside speech, anchors inside the reel. The face is
// the robust one (`facesOver`) the layout engine places around. Text over text
// is a hard rule (rule 5 of `specs/layout-engine.md`), so the check is strict;
// the one excuse is a caption the engine record notes `no-spot` (decision 19: a
// caption is never left out, so with no legal spot it sits over the texts on
// screen, its blockers naming them): the pair of that caption and a text its
// note names. The engine never fails this check. `boxes` holds the captions shown in their place
// (never those a transition or an extra shows), `levels` the transitions'
// text levels (`transitionId` is the transition they belong to), checked for
// the safe box and for overlaps. `same-text`: no spoken word (by word id) is
// shown by two items at a shared moment, a caption shown in its place or a
// text component (an accent, a big word, a list); the engine never fails it.
export function runChecks(
  edit: Edit,
  boxes: readonly TextBox[],
  resolved: ReadonlyMap<string, ResolvedItem>,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  bigWords: readonly BigWordBox[] = [],
  // The transitions' text levels: inside the safe box and on no other text.
  levels: readonly (TextBox & { transitionId: string })[] = [],
  // The engine's record of the placement (the captions with no legal spot).
  record: readonly EngineNote[] = [],
): Check[] {
  const checks: Check[] = [];
  const safe = SAFE_ZONE.box;

  // Every text as a box inside the frame: the captions and overlays, the
  // transitions' levels, then the big words.
  const framed = [
    ...[...boxes, ...levels].map((box) => ({ ...box, what: label(box) })),
    ...bigWords.map((word) => ({ ...word, what: wordLabel(word) })),
  ];
  for (const box of framed) {
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
        reason: `${box.what} runs past the safe box: ${edges.join(", ")}`,
      });
    } else if (
      overlaps({ left: box.x, right, top: box.y, bottom }, shrink(SAFE_ZONE.notch, SLACK))
    ) {
      const { left, top } = SAFE_ZONE.notch;
      checks.push({
        rule: "safe-box",
        item: box.itemId,
        reason: `${box.what} runs into the platform button column below y ${top}: right edge ${px(right)} > ${left}`,
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

  // Texts shown at a moment: each one's id (a level's transition), its name,
  // box and span. Two that share a moment must not overlap on screen.
  const texts: { owner: string; what: string; rect: Box; start: number; end: number }[] = [
    ...boxes.map((box) => ({
      owner: box.itemId,
      what: label(box),
      rect: { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height },
      start: box.start,
      end: box.end,
    })),
    ...levels.map((box) => ({
      owner: box.transitionId,
      what: label(box),
      rect: { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height },
      start: box.start,
      end: box.end,
    })),
    ...bigWords.map((word) => {
      const span = resolved.get(word.itemId)!;
      return {
        owner: word.itemId,
        what: wordLabel(word),
        rect: {
          left: word.x,
          right: word.x + word.width,
          top: word.y,
          bottom: word.y + word.height,
        },
        start: span.start,
        end: span.end,
      };
    }),
  ];
  // One of the pair is a caption with no legal spot whose `no-spot` note names
  // the other as a blocker (decision 19).
  const blocks = (note: EngineNote, id: string) =>
    note.blockers.some((blocker) => "id" in blocker && blocker.id === id);
  const excused = (a: string, b: string) =>
    record.some(
      (note) =>
        note.outcome === "no-spot" &&
        note.component === "CAPTION" &&
        ((note.item === a && blocks(note, b)) || (note.item === b && blocks(note, a))),
    );
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index]!;
    for (const other of texts.slice(0, index)) {
      if (!(text.start < other.end - SLACK && other.start < text.end - SLACK)) continue;
      if (!overlaps(shrink(text.rect, SLACK), other.rect)) continue;
      if (text.owner !== other.owner && excused(text.owner, other.owner)) continue;
      checks.push({
        rule: "text-overlap",
        item: text.owner,
        reason: `${text.what} sits on ${other.what} while both are shown`,
      });
    }
  }

  // A big word behind the speaker never sits on a visual card while both show
  // (decision 24: the card is in front of the speaker, the word behind it). A big
  // word with no cut-out is front text: it draws above the card, so it may sit on one.
  const behindItems = edit.tracks.behind ?? [];
  const cards = behindItems.flatMap((item) => (item.kind === "visual" ? [item] : []));
  for (const word of bigWords) {
    const item = behindItems.find((entry) => entry.id === word.itemId);
    if (!item || !needsCutout(item)) continue;
    const span = resolved.get(word.itemId)!;
    const rect = {
      left: word.x,
      right: word.x + word.width,
      top: word.y,
      bottom: word.y + word.height,
    };
    for (const card of cards) {
      const cardSpan = resolved.get(card.id)!;
      if (!(span.start < cardSpan.end - SLACK && cardSpan.start < span.end - SLACK)) continue;
      if (!overlaps(shrink(rect, SLACK), visualBox(card))) continue;
      checks.push({
        rule: "card-overlap",
        item: word.itemId,
        reason: `${wordLabel(word)} sits on the visual ${card.id} while both are shown`,
      });
    }
  }

  // Every item showing spoken words, with its words and span: the captions
  // shown (not those a text shows), the accents, the lists and the big words.
  const showing: { id: string; words: readonly string[]; start: number; end: number }[] = [
    ...edit.tracks.captions
      .filter((caption) => caption.hidden_by === undefined)
      .map((caption) => ({ id: caption.id, words: caption.words })),
    ...edit.tracks.overlays.flatMap((item) =>
      item.words ? [{ id: item.id, words: item.words }] : [],
    ),
    ...edit.tracks.transitions.map((item) => ({ id: item.id, words: item.words })),
    ...(edit.tracks.behind ?? []).flatMap((item) =>
      item.kind === "word" && item.words ? [{ id: item.id, words: item.words }] : [],
    ),
  ].map((item) => ({ ...item, ...resolved.get(item.id)! }));
  const spoken = new Map(transcript.words.map((word) => [word.id, word.text]));
  for (let index = 1; index < showing.length; index += 1) {
    const later = showing[index]!;
    for (const earlier of showing.slice(0, index)) {
      const from = Math.max(earlier.start, later.start);
      const to = Math.min(earlier.end, later.end);
      if (to <= from + SLACK) continue;
      const shared = later.words.filter((id) => earlier.words.includes(id));
      if (shared.length === 0) continue;
      const text = shared.map((id) => JSON.stringify(spoken.get(id) ?? id)).join(" ");
      checks.push({
        rule: "same-text",
        item: later.id,
        reason: `${earlier.id} and ${later.id} both show ${text} from ${from.toFixed(3)} to ${to.toFixed(3)} s`,
      });
    }
  }

  for (const box of boxes) {
    // A caption keeps its minimum. The hook keeps the shown floor. An accent,
    // a question or a list shows exactly its words, so it only has a length
    // (no minimum); a text the engine cut or moved still shows its words.
    const min =
      box.kind === "caption"
        ? preset.caption.minSeconds
        : box.kind === "hook"
          ? SHOWN_FLOOR_SECONDS
          : 0;
    const span = resolved.get(box.itemId)!;
    if (span.end - span.start < min - SLACK || span.end <= span.start) {
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
    // A two-word big word is timed from its first spoken word.
    const first = item.text.split(" ")[0]!.toLowerCase();
    const said = transcript.words
      .filter((word) => cleanWord(word.text, preset).toLowerCase() === first)
      .sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0];
    const lead = timingOf(VARIANTS["bigword/behind"], "words-lead").lead;
    if (said && start < said.start - lead - SLACK) {
      checks.push({
        rule: "big-word-timing",
        item: item.id,
        reason: `big word ${item.id} (${JSON.stringify(item.text)}) shows at ${start.toFixed(3)} s, more than ${lead} s before ${said.id} is said at ${said.start.toFixed(3)} s`,
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
