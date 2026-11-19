import { placedBigWord } from "./behind.ts";
import { build } from "./build.ts";
import {
  type CaptionBlock,
  captionBlocks,
  captionText,
  isCaptionBlockId,
  layBlock,
  storedLines,
  wrapGroup,
} from "./caption-blocks.ts";
import type { PlacedComponent } from "./components.ts";
import type { EngineComponent, EngineNote } from "./engine-note.ts";
import type { HeadTrack } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import {
  blockUnits,
  breaksFor,
  hundredth,
  overlayFont,
  restack,
  withoutBreaks,
  wrapToWidth,
} from "./owner-edit.ts";
import { type Preset, wordsText } from "./preset.ts";
import { isQuestion, questionText } from "./question.ts";
import { levelMark, withOwnerMarks } from "./owner-marks.ts";
import type { CaptionItem, Edit } from "./schema.ts";
import { STYLES } from "./variants.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";
import { levelBoxes } from "./transitions.ts";

// THE OWNER'S TEXT EDITS (app_docs/owner-edits.md; owner decisions
// 2026-11-19): in the studio's Edit mode the owner fixes the words of one
// text in place. An edit changes ONLY the element edited: the same spoken
// word in another element keeps its text (the curator's `word_fixes` apply
// everywhere; this is per element). Nothing about time changes: the element
// keeps its spoken words, and the edited text is spread over them in order
// (`wordReveal`'s rule for a text with another word count), so it still comes
// in with the voice. The box keeps its place and its text size: the text is
// wrapped again inside the box's width, and the box grows downward when it
// needs more lines. No element is added or removed.

// One text edit: the component's id (a caption block's is its block's), the
// part of it edited where it has parts (a LIST's level, `lead` or `key`; a
// caption block's group, by its first caption's id) and the new text.
export interface OwnerText {
  id: string;
  part?: string;
  text: string;
}

// How many text edits one save may carry.
export const OWNER_TEXTS_MAX = 200;

// The longest an edited text may be: three times the characters of the text
// it replaces (the version's own), and never fewer than this many, so a short
// text can still be rewritten.
const TEXT_ROOM = 3;
const TEXT_FLOOR = 40;
// The format's own limits (`schema.ts`): a caption's or an overlay's text, and
// a list level's.
const TEXT_MAX = 200;
const LEVEL_MAX = 300;

// How long a text that replaces `original` may be, in characters.
export function ownerTextLimit(original: string, formatMax = TEXT_MAX): number {
  return Math.min(formatMax, Math.max(TEXT_FLOOR, original.length * TEXT_ROOM));
}

// The owner's text as it is stored: every run of white space (a line break
// included) one space, none at the ends, no control character.
export function cleanOwnerText(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const keyOf = (text: Pick<OwnerText, "id" | "part">): string => `${text.id}\n${text.part ?? ""}`;

// A job's text edits as they arrive (untrusted JSON): absent is none; else a
// list of at most `OWNER_TEXTS_MAX`, each an id, an optional part and a text
// (strings, the text already clean and at most 300 characters), no element
// twice. Null when it is anything else.
export function parseOwnerTexts(json: unknown): OwnerText[] | null {
  if (json === undefined) return [];
  if (!Array.isArray(json) || json.length > OWNER_TEXTS_MAX) return null;
  const texts: OwnerText[] = [];
  const seen = new Set<string>();
  for (const entry of json as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, part, text } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 80) return null;
    if (part !== undefined && (typeof part !== "string" || part.length === 0 || part.length > 64)) {
      return null;
    }
    if (typeof text !== "string" || text.length > LEVEL_MAX) return null;
    if (cleanOwnerText(text) !== text) return null;
    const parsed: OwnerText = part === undefined ? { id, text } : { id, part, text };
    if (seen.has(keyOf(parsed))) return null;
    seen.add(keyOf(parsed));
    texts.push(parsed);
  }
  return texts;
}

interface Context {
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  measurer: Measurer;
}

type Levels = NonNullable<Edit["tracks"]["transitions"][number]["levels"]>;

// What a text edit names in an edit: the element, the text it shows now, the
// spoken words it is tied to (none for the hook) and the longest text the
// format lets it hold.
type Target =
  | {
      kind: "overlay";
      component: EngineComponent;
      item: Edit["tracks"]["overlays"][number];
      text: string;
      words: string[];
      max: number;
    }
  | {
      kind: "word";
      component: EngineComponent;
      item: Extract<NonNullable<Edit["tracks"]["behind"]>[number], { kind: "word" }>;
      text: string;
      words: string[];
      max: number;
    }
  | {
      kind: "level";
      component: EngineComponent;
      item: Edit["tracks"]["transitions"][number];
      levels: Levels;
      role: "lead" | "key";
      text: string;
      words: string[];
      max: number;
    }
  | {
      kind: "captions";
      component: EngineComponent;
      block: CaptionBlock;
      items: CaptionItem[];
      text: string;
      words: string[];
      max: number;
    };

function targetOf(
  edit: Edit,
  { id, part }: Pick<OwnerText, "id" | "part">,
  { transcript, preset }: Pick<Context, "transcript" | "preset">,
): Target | string {
  if (isCaptionBlockId(id)) {
    const block = captionBlocks(edit, transcript).find((entry) => entry.id === id);
    if (!block) return `${id}: not a caption block of this version`;
    const group = block.groups.find((entry) => entry.id === part);
    if (!group) return `${id}: ${part ?? "no part"} is no group of this caption block`;
    const byId = new Map(edit.tracks.captions.map((item) => [item.id, item]));
    const items = group.captions.map((caption) => byId.get(caption)!);
    return {
      kind: "captions",
      component: "CAPTION",
      block,
      items,
      text: items.map((item) => captionText(item, transcript, preset)).join(" "),
      words: items.flatMap((item) => item.words),
      max: TEXT_MAX,
    };
  }
  const overlay = edit.tracks.overlays.find((item) => item.id === id);
  if (overlay) {
    if (part !== undefined) return `${id}: this text has no parts`;
    const written = overlay.text ?? wordsText(overlay.words ?? [], transcript, preset);
    const question = isQuestion(overlay);
    return {
      kind: "overlay",
      component: overlay.kind === "hook" ? "HOOK" : question ? "QUESTION" : "ACCENT",
      item: overlay,
      text: question ? questionText(written) : written,
      words: overlay.words ?? [],
      max: TEXT_MAX,
    };
  }
  const word = (edit.tracks.behind ?? []).find((item) => item.id === id);
  if (word?.kind === "word") {
    if (part !== undefined) return `${id}: this text has no parts`;
    return {
      kind: "word",
      component: "BIGWORD",
      item: word,
      text: word.text,
      words: word.words ?? [],
      max: TEXT_MAX,
    };
  }
  const list = edit.tracks.transitions.find((item) => item.id === id);
  if (list?.levels) {
    if (part !== "lead" && part !== "key") {
      return `${id}: a list's text is its lead-in or its key phrase; its number is not edited`;
    }
    const level = list.levels[part];
    if (!level) return `${id}: this list has no ${part} text`;
    const at = list.key === undefined ? -1 : list.words.indexOf(list.key);
    const words =
      at < 0 ? list.words : part === "lead" ? list.words.slice(0, at) : list.words.slice(at);
    return {
      kind: "level",
      component: "LIST",
      item: list,
      levels: list.levels,
      role: part,
      text: level.text,
      words,
      max: LEVEL_MAX,
    };
  }
  return `${id}: not a text of this version`;
}

// The text an element shows now, as the owner's inline editor starts from it,
// and how long its replacement may be; null for anything that is no text (a
// VISUAL, a single caption, a list's number).
export function ownerTextOf(
  edit: Edit,
  target: Pick<OwnerText, "id" | "part">,
  context: Pick<Context, "transcript" | "preset">,
): { text: string; limit: number } | null {
  const found = targetOf(edit, target, context);
  if (typeof found === "string") return null;
  return { text: found.text, limit: ownerTextLimit(found.text, found.max) };
}

// Why a text cannot replace an element's, in the owner's words; null when it
// can. `text` is clean (`cleanOwnerText`).
function textProblem(target: Target, text: string, carried = false): string | null {
  if (text.length === 0) return "A text cannot be empty";
  const limit = carried ? target.max : ownerTextLimit(target.text, target.max);
  if (text.length > limit) {
    return `This text can be at most ${limit} characters (it has ${text.length})`;
  }
  return null;
}

// The same for the studio, before anything is applied: why the owner's text
// cannot replace the element's in this edit (the version's own), or null.
export function ownerTextProblem(
  edit: Edit,
  text: OwnerText,
  context: Pick<Context, "transcript" | "preset">,
): string | null {
  const target = targetOf(edit, text, context);
  if (typeof target === "string") return "This text cannot be edited";
  return textProblem(target, text.text);
}

// The text edits that change something: one whose text is what the element
// already shows in `edit` is left out.
export function effectiveTexts(
  texts: readonly OwnerText[],
  edit: Edit,
  context: Pick<Context, "transcript" | "preset">,
): OwnerText[] {
  return texts.filter((text) => {
    const target = targetOf(edit, text, context);
    if (typeof target === "string") return true;
    // A question shows its mark whether the owner typed it or not.
    const shown = target.component === "QUESTION" ? questionText(text.text) : text.text;
    return target.text !== shown;
  });
}

// The words of a text spread over `count` units in order, the rule `wordReveal`
// uses for a text with another word count than its spoken words: as many words
// as units, one each; else word i goes to unit floor(i * count / words). The
// first unit always has a word; a unit can have several, or none.
export function spreadWords(text: string, count: number): string[][] {
  const words = text.split(" ");
  const out: string[][] = Array.from({ length: count }, () => []);
  words.forEach((word, index) => {
    const at = words.length === count ? index : Math.floor((index * count) / words.length);
    out[at]!.push(word);
  });
  return out;
}

// A caption group with the owner's text: its words spread over the group's
// captions in order. A caption left with no word goes: its spoken words join
// the caption before it, which shows on the first of them, so every spoken
// word is still some caption's and the text still follows the voice. A caption
// whose text is its words' own keeps no `text`.
function captionsWithText(
  items: readonly CaptionItem[],
  text: string,
  { transcript, preset }: Pick<Context, "transcript" | "preset">,
): CaptionItem[] {
  const out: CaptionItem[] = [];
  spreadWords(text, items.length).forEach((words, index) => {
    const item = items[index]!;
    const last = out.at(-1);
    if (words.length === 0 && last) {
      out[out.length - 1] = { ...last, words: [...last.words, ...item.words] };
      return;
    }
    out.push({ ...item, text: words.join(" ") });
  });
  return out.map((item) => {
    if (item.text !== wordsText(item.words, transcript, preset)) return item;
    const plain = { ...item };
    delete plain.text;
    return plain;
  });
}

// A caption block with a run of one group's captions replaced (`run`, their
// ids, by `replaced`, in their place in the track) and laid again: that group
// wrapped to the block's width between whole captions, every other group on
// its own lines, the block's top and centre line kept (`box`, the block as it
// was). A block as wide as it was leaves its other captions exactly where
// they are. The captions of the whole track, and the block as it is now.
export function relaidBlock(
  edit: Edit,
  block: CaptionBlock,
  groupId: string,
  run: readonly string[],
  replaced: readonly CaptionItem[],
  box: { x: number; y: number; width: number; size: number | null },
  context: Pick<Context, "transcript" | "preset" | "measurer">,
): { captions: CaptionItem[]; block: CaptionBlock } {
  const { preset, measurer } = context;
  const gone = new Set(run);
  const all = edit.tracks.captions;
  const first = all.findIndex((item) => item.id === run[0]);
  const others = all.filter((item) => !gone.has(item.id));
  const at = all.slice(0, first).filter((item) => !gone.has(item.id)).length;
  let captions = [...others.slice(0, at), ...replaced, ...others.slice(at)];
  const blockNow: CaptionBlock = {
    ...block,
    groups: block.groups.map((group) => {
      if (group.id !== groupId) return group;
      const from = group.captions.indexOf(run[0]!);
      const kept = group.captions.filter((id) => !gone.has(id));
      const ids = [...kept.slice(0, from), ...replaced.map((item) => item.id), ...kept.slice(from)];
      return { ...group, id: ids[0]!, captions: ids };
    }),
  };
  const groupNow = blockNow.groups[block.groups.findIndex((group) => group.id === groupId)]!;
  const groups = blockUnits({ ...edit, tracks: { ...edit.tracks, captions } }, blockNow, context);
  const size = box.size!;
  const laid = layBlock(
    groups.map((group) => ({
      units: group.units,
      lines:
        group.items[0]!.id === groupNow.id
          ? wrapGroup(group.units, size, box.width, measurer)
          : storedLines(group.items),
    })),
    box,
    size,
    preset.caption.lineGap,
    measurer,
    box.x + box.width / 2,
  );
  const sameWidth = Math.abs(laid.width - box.width) < 0.005;
  const moved = new Set(groupNow.captions);
  captions = captions.map((item) => {
    const place = laid.places.get(item.id);
    if (!place || (sameWidth && !moved.has(item.id))) return item;
    return { ...item, position: { x: place.x, y: place.y, align: "left" as const } };
  });
  return { captions, block: blockNow };
}

// The edit with the owner's text edits applied, nothing else changed. Each
// edited element keeps its place, its text size, its time and its spoken
// words; its text is wrapped again inside its box's width (the engine's
// balanced lines), so the box grows downward when the text needs more lines:
// - an accent, a question or the hook: its `text` and `breaks`, its box's top
//   kept and its lines centred where they were (a question, set left-aligned,
//   keeps its left edge; its mark is added when the text has none);
// - a big word: its `text` and `breaks` (any text, wrapped inside the word's
//   width like an accent's; the one or two plain words rule is the AI
//   answer's, never the owner's), its top and centre kept;
// - a LIST's lead-in or key phrase: the level's `text`, that level wrapped to
//   the list's width and the levels stacked again on the list's centre line;
// - a caption block's group: the text spread over the group's captions in
//   order (`captionsWithText`), the group wrapped to the block's width between
//   whole captions, the block's top and centre line kept.
// Refused with reasons: an element that is no text, an empty text, one longer
// than `ownerTextLimit`, a big word that is no big word, an element edited
// twice.
export function applyOwnerTexts(
  edit: Edit,
  texts: readonly OwnerText[],
  // `carried`: a text the owner wrote in an earlier version, carried into a
  // new placement (`owner-carry.ts`). It was within its limit when written,
  // so only the format's own length binds it here.
  context: Context & { carried?: boolean },
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  if (texts.length === 0) return { ok: true, edit };
  const { transcript, headTrack, preset, measurer } = context;
  const reasons: string[] = [];
  const seen = new Set<string>();
  const targets: { target: Target; text: string }[] = [];
  for (const entry of texts) {
    if (seen.has(keyOf(entry))) {
      reasons.push(`${entry.id}: its text is edited twice`);
      continue;
    }
    seen.add(keyOf(entry));
    const target = targetOf(edit, entry, context);
    if (typeof target === "string") {
      reasons.push(target);
      continue;
    }
    const problem = textProblem(target, entry.text, context.carried === true);
    if (problem) reasons.push(`${entry.id}: ${problem}`);
    else if (cleanOwnerText(entry.text) !== entry.text) {
      reasons.push(`${entry.id}: its text has stray white space`);
    } else targets.push({ target, text: entry.text });
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const components = build(edit, transcript, headTrack, preset, measurer, {
    layer: "front",
  }).components;
  const boxOf = (id: string): PlacedComponent => {
    const found = components.find((component) => component.id === id);
    if (!found) throw new Error(`owner-text: ${id} is not on the page`);
    return found;
  };
  let { captions, overlays, transitions } = edit.tracks;
  let behind = edit.tracks.behind;
  // The texts the owner wrote, marked in the version (`owner-marks.ts`).
  const marks: string[] = [];
  // Each edited block's groups as they are now (an edited group may have
  // fewer captions), so a second edit in the same sentence lays the first.
  const blocksNow = new Map<string, CaptionBlock>();
  for (const { target, text } of targets) {
    if (target.kind === "overlay") {
      const { item } = target;
      marks.push(item.id);
      const box = boxOf(item.id);
      const question = isQuestion(item);
      const lines = wrapToWidth(
        question ? questionText(text) : text,
        overlayFont(item),
        box.size!,
        box.width,
        measurer,
      );
      const width = Math.max(
        ...lines.map((line) => measurer.width(overlayFont(item), box.size!, line)),
      );
      const left = question ? box.x : box.x + (box.width - width) / 2;
      overlays = overlays.map((entry) =>
        entry.id === item.id
          ? {
              ...withoutBreaks(entry),
              text,
              position: { x: hundredth(left), y: box.y, align: "left" as const },
              ...breaksFor(lines),
            }
          : entry,
      );
      continue;
    }
    if (target.kind === "word") {
      const { item } = target;
      marks.push(item.id);
      const box = boxOf(item.id);
      const lines = wrapToWidth(text, STYLES.bigWord.font, box.size!, box.width, measurer);
      const next = { ...withoutBreaks(item), text, ...breaksFor(lines) };
      const width = placedBigWord(next, { x: box.x, y: box.y }, box.size!, measurer).width;
      const x = Math.max(0, hundredth(box.x + (box.width - width) / 2));
      behind = behind?.map((entry) =>
        entry.id === item.id ? { ...next, position: { x, y: box.y } } : entry,
      );
      continue;
    }
    if (target.kind === "level") {
      const { item, role } = target;
      marks.push(levelMark(item.id, role));
      // The list as it is now (an earlier edit of its other level included).
      const now = transitions.find((entry) => entry.id === item.id)!;
      const levels: Levels = { ...now.levels!, [role]: { ...now.levels![role]!, text } };
      const box = boxOf(item.id);
      const own = levelBoxes(
        { ...edit, tracks: { ...edit.tracks, transitions } },
        resolveTimeline(edit, transcript),
        new Map(transcript.words.map((word) => [word.id, word])),
        preset,
        measurer,
      ).filter((level) => level.transitionId === item.id);
      const stacked = restack(
        levels,
        own,
        { id: item.id, x: box.x, y: box.y, size: levels.key.size, width: box.width },
        1,
        measurer,
        [role],
      );
      const width = Math.max(...[...stacked.values()].map((level) => level.width));
      const shift = Math.round((box.width - width) / 2);
      const placed = (name: "number" | "lead" | "key") => {
        const level = levels[name];
        const at = stacked.get(name);
        if (!level || !at) return level;
        return {
          ...withoutBreaks(level),
          position: { x: at.x + shift, y: at.y, align: "left" as const },
          ...breaksFor(at.lines),
        };
      };
      const number = placed("number");
      const lead = placed("lead");
      transitions = transitions.map((entry) =>
        entry.id === item.id
          ? {
              ...entry,
              levels: {
                ...(number ? { number } : {}),
                ...(lead ? { lead } : {}),
                key: placed("key")!,
              },
            }
          : entry,
      );
      continue;
    }
    // A caption block's group.
    const { block, items } = target;
    const edited = captionsWithText(items, text, context);
    marks.push(...edited.map((item) => item.id));
    const relaid = relaidBlock(
      { ...edit, tracks: { ...edit.tracks, captions } },
      blocksNow.get(block.id) ?? block,
      items[0]!.id,
      items.map((item) => item.id),
      edited,
      boxOf(block.id),
      context,
    );
    captions = relaid.captions;
    blocksNow.set(block.id, relaid.block);
  }
  return {
    ok: true,
    edit: withOwnerMarks(
      {
        ...edit,
        tracks: { ...edit.tracks, captions, overlays, transitions, ...(behind ? { behind } : {}) },
      },
      { texts: marks },
    ),
  };
}

// One text the owner edited, for learning later (the `owner_texts` table): the
// element, the text before (the version edited) and after, and the spoken
// words it is tied to.
export interface OwnerTextRecord {
  item: string;
  // A LIST's level or a caption block's group; null for a text with no parts.
  part: string | null;
  component: EngineComponent;
  // The entry the engine placed it with, when its record names one.
  variant: string | null;
  before: string;
  after: string;
  // The spoken words the text is tied to, as the transcript has them, and
  // their ids; empty for the hook, which nobody says.
  words: string;
  word_ids: string[];
  start: number;
  end: number;
  context: {
    frame: { width: number; height: number };
    font_pair: string;
    size: number | null;
    // The element's box before and after the edit (the text wrapped again
    // inside its width; any move of the same save included in `after`).
    before_box: { x: number; y: number; width: number; height: number } | null;
    after_box: { x: number; y: number; width: number; height: number } | null;
  };
}

// The learning records of the text edits of one save. `before` is the version
// the owner edited, `after` the version being saved, each with its components.
export function ownerTextRecords({
  texts,
  before,
  after,
  transcript,
  preset,
  engineRecord = [],
}: {
  texts: readonly OwnerText[];
  before: { edit: Edit; components: readonly PlacedComponent[] };
  after: { edit: Edit; components: readonly PlacedComponent[] };
  transcript: Transcript;
  preset: Preset;
  engineRecord?: readonly EngineNote[];
}): OwnerTextRecord[] {
  const spoken = new Map(transcript.words.map((word) => [word.id, word.text]));
  const boxIn = (components: readonly PlacedComponent[], id: string) => {
    const at = components.find((component) => component.id === id);
    return at ? { x: at.x, y: at.y, width: at.width, height: at.height } : null;
  };
  const records: OwnerTextRecord[] = [];
  for (const text of texts) {
    const target = targetOf(before.edit, text, { transcript, preset });
    if (typeof target === "string") continue;
    const placed = after.components.find((component) => component.id === text.id);
    const span = placed ?? before.components.find((component) => component.id === text.id);
    // A caption block's notes are its captions'.
    const noted = target.kind === "captions" ? target.block.groups[0]!.id : text.id;
    records.push({
      item: text.id,
      part: text.part ?? null,
      component: target.component,
      variant: engineRecord.find((entry) => entry.item === noted)?.variant ?? null,
      before: target.text,
      after: target.component === "QUESTION" ? questionText(text.text) : text.text,
      words: target.words.map((id) => spoken.get(id) ?? "").join(" "),
      word_ids: [...target.words],
      start: span?.start ?? 0,
      end: span?.end ?? 0,
      context: {
        frame: { width: preset.frame.width, height: preset.frame.height },
        font_pair: after.edit.font_pair,
        size: placed?.size ?? null,
        before_box: boxIn(before.components, text.id),
        after_box: boxIn(after.components, text.id),
      },
    });
  }
  return records;
}
