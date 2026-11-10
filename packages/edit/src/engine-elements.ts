// THE ELEMENTS (`specs/layout-engine.md`, "The loop" and the details the steps settled):
// each component's element through the placer (`placeElement`, `engine-place.ts`) and the
// writes it makes: the edit's overlays, behind items, LIST transitions and captions, with
// their notes in the record. The engine (`engine.ts`) times the picks, builds the scene and
// calls these in placement order.

import type { AccentChoice, HookChoice, TransitionChoice, VisualChoice } from "./engine-input.ts";
import {} from "./engine-input.ts";
import type { RecordNote } from "./engine-note.ts";
import {
  type BlockElement,
  type BoxElement,
  type LevelRole,
  MIN_SIZE_PX,
  type StackElement,
  type TextElement,
  placeElement,
  stackPositions,
} from "./engine-place.ts";
import { bigWordNeedsCutout, paddedSpan } from "./behind.ts";
import { overlaps } from "./engine-space.ts";
import type { Box, HeadTrack } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { type Preset, cleanWord } from "./preset.ts";
import type { PickedVariants } from "./variant-picker.ts";
import { wordsText } from "./glossary.ts";
import { anchorAt } from "./timeline.ts";
import { boxVariantOf, stackVariantOf, textVariantOf } from "./variant-picker.ts";
import { STYLES, type StandIn } from "./variants.ts";
import { type Moment, type Shown, placerScene } from "./engine-scene.ts";
import { type CaptionBlock, at, during, ms, quote } from "./engine-timing.ts";
import type {
  BehindItem,
  CaptionItem,
  OverlayItem,
  TransitionItem,
  TransitionLevel,
} from "./schema.ts";
import type { SentenceSpan, Transcript, Word } from "./transcript.ts";
import type { Anchor } from "./schema.ts";

// The words of an answer: the transcript's words by id and by range, the
// sentence of a word, and the preset.
export interface Words {
  transcript: Transcript;
  preset: Preset;
  word: (id: string) => Word;
  range: (from: string, to: string) => string[];
  sentenceOf: (id: string) => SentenceSpan | undefined;
  order: ReadonlyMap<string, number>;
}

// What the element writers read and write: the words, the picked entries, the
// record, the texts on screen (`shown`), the scene's moments, the tracks being
// built and the captions' places.
export interface Pass extends Words {
  picked: PickedVariants;
  measurer: Measurer;
  // The head track and the reel's length: a big word's cut-out is read from them.
  headTrack: HeadTrack;
  duration: number;
  record: RecordNote[];
  shown: Shown[];
  scene: readonly Moment[];
  overlays: Map<string, OverlayItem>;
  behind: Map<string, BehindItem>;
  transitionItems: Map<string, { index: number; item: TransitionItem }>;
  placedCaptions: Map<number, { x: number; y: number; size: number }>;
  captions: readonly CaptionItem[];
  texts: readonly string[];
  fixes: ReadonlyMap<string, string>;
  unitEnd: ReadonlyMap<number, number>;
}

// The longest text of a transition's level (the schema's cap).
const LEVEL_TEXT_MAX = 300;

// The hook's answer reference (in a checklist) and item id.
export const HOOK_REF = "hook";
export const HOOK_ID = "hook";

// A big word's text: its one or two words, cleaned, joined by a space.
export function bigWordText(words: Words, from: string, to: string): string {
  return words
    .range(from, to)
    .map((id) => cleanWord(words.word(id).text, words.preset))
    .join(" ");
}

// An accent's or a question's text: its words, as the captions show them.
export function accentText(words: Words, accent: AccentChoice): string {
  return wordsText(words.range(accent.from, accent.to), words.transcript, words.preset);
}

// What a note calls an element: the hook's text, the accent's or question's,
// the big word's, the visual's number.
export function describe(words: Words, extra: Extra): string {
  if (extra.kind === "hook") return `the hook ${quote(extra.hook!.text)}`;
  if (extra.kind === "accent") {
    const accent = extra.accent!;
    return `${accentNoun(accent)} ${quote(accentText(words, accent))}`;
  }
  if (extra.kind === "big_word") {
    return `the big word ${quote(bigWordText(words, extra.word!, extra.wordTo!))}`;
  }
  return `visual ${extra.index + 1}`;
}

// The start anchor of an item coming in at `at`: its word, plus the offset from
// the word's start (none for an accent or a question).
function startAnchorOf(pass: Pass, id: string, at: number): Anchor {
  const offset = ms(at - pass.word(id).start);
  if (Math.abs(offset) > 1) return anchorAt(at, pass.transcript.words);
  return offset === 0 ? { word: id } : { word: id, offset };
}

// The placer's scene over a span (`placerScene`, `engine-scene.ts`).
function sceneFor(pass: Pass, span: { start: number; end: number }) {
  return placerScene(pass.scene, pass.shown, span);
}

// One extra at its own span, placed by its kind, each through the placer. An
// element (the hook, an accent, a question, the big word, a visual's card) it
// finds no legal spot for is left out (false), and the caller notes it.
export function placeExtra(pass: Pass, extra: Extra): boolean {
  const span = { start: extra.start, end: extra.end };
  return extra.kind === "hook"
    ? placeHook(pass, extra, span)
    : extra.kind === "accent"
      ? placeAccent(pass, extra, span)
      : extra.kind === "big_word"
        ? placeBigWord(pass, extra, span)
        : placeVisual(pass, extra, span);
}

export interface Extra {
  ref: string;
  // `hook`: the written hook, on its window.
  kind: "accent" | "big_word" | "visual" | "hook";
  id: string;
  start: number;
  end: number;
  // Its place in the answer's list.
  index: number;
  accent?: AccentChoice;
  visual?: VisualChoice;
  // A big word's first and last word (the same for one word).
  word?: string;
  wordTo?: string;
  hook?: HookChoice;
  // A visual's stand-in picture (`VISUAL_STAND_INS`), set by the loop in start-time order.
  image?: StandIn;
}

// A LIST item kept by the timing rules: its answer item and its layer's span.
// `index` is its place among all LIST items of the answer (its id is
// `transition-<index + 1>`), `list` its list's place among the answer's lists
// (1, 2, ...), `number` its place in its list when the list kept more than one
// item (none for a list of one).
export interface TransitionPlan {
  ref: string;
  index: number;
  list: number;
  number?: number;
  id: string;
  label: string;
  choice: TransitionChoice;
  start: number;
  end: number;
  startAnchor: Anchor;
  endAnchor: Anchor;
}

// What a note calls an accent-look item: a QUESTION or an accent.
export function accentNoun(accent: AccentChoice): string {
  return accent.question ? "question" : "accent";
}

// The texts on screen over `span` that a box overlaps.
function textsOver(
  shown: readonly Shown[],
  box: Box,
  span: { start: number; end: number },
): Shown[] {
  return shown.filter(
    (item) => item.kind !== "box" && during(item, span) && overlaps(box, item.box),
  );
}
// The text of a LIST item's levels: the number, the lead-in (the words before
// `key_from`) and the key phrase, as the captions show them.
function levelTexts(pass: Pass, plan: TransitionPlan): { lead: string; key: string } {
  const { transcript, preset, record, captions, texts, fixes, range, word, order } = pass;
  const { choice, label } = plan;
  const ids = range(choice.from, choice.to);
  const phrase = new Set(ids);
  const keyAt = order.get(choice.key_from)!;
  // The phrase's text, after the word fixes: each word as the caption
  // showing it (once per caption), a word no caption shows as itself. A
  // caption goes to the lead-in or the key phrase by its first word; one
  // starting before the phrase keeps its own place and is left out here.
  const captionOf = new Map<string, number>();
  captions.forEach((caption, index) => {
    if (caption.hidden_by !== plan.id) return;
    for (const id of caption.words) if (!captionOf.has(id)) captionOf.set(id, index);
  });
  const parts: { at: number; text: string }[] = [];
  const used = new Set<number>();
  for (const id of ids) {
    const index = captionOf.get(id);
    if (index === undefined) {
      parts.push({
        at: order.get(id)!,
        text: fixes.get(id) ?? wordsText([id], transcript, preset),
      });
      continue;
    }
    if (used.has(index)) continue;
    used.add(index);
    const first = captions[index]!.words[0]!;
    if (!phrase.has(first)) continue;
    parts.push({ at: order.get(first)!, text: texts[index]! });
  }
  let leadParts = parts.filter((part) => part.at < keyAt);
  let keyParts = parts.filter((part) => part.at >= keyAt);
  if (keyParts.length === 0) {
    keyParts = leadParts.slice(-1);
    leadParts = leadParts.slice(0, -1);
  }
  let lead = leadParts.map((part) => part.text).join(" ");
  let key = keyParts.map((part) => part.text).join(" ");
  // A phrase whose captions all begin before it has no text of its own, so
  // its words (as the captions would show them, after the fixes) are its
  // text. A text over the level's cap is cut at a word.
  if (!key) {
    key =
      ids
        .map((id) => fixes.get(id) ?? wordsText([id], transcript, preset))
        .join(" ")
        .trim() || ids.map((id) => word(id).text.trim()).join(" ");
    lead = "";
    record.push({
      item: plan.id,
      action: "text-from-words",
      rule: "transition-text",
      reason: `${label} has no caption text of its own: it shows the words of its phrase, ${quote(key)}`,
    });
  }
  const capped = (text: string) => {
    if (text.length <= LEVEL_TEXT_MAX) return text;
    let out = "";
    for (const piece of text.split(" ")) {
      const next = out ? `${out} ${piece}` : piece;
      if (next.length > LEVEL_TEXT_MAX) break;
      out = next;
    }
    record.push({
      item: plan.id,
      action: "text-from-words",
      rule: "transition-text",
      reason: `${label} shows its first ${out.length} characters: its text is longer than ${LEVEL_TEXT_MAX}`,
    });
    return out;
  };
  lead = lead.length > LEVEL_TEXT_MAX ? capped(lead) : lead;
  key = key.length > LEVEL_TEXT_MAX ? capped(key) : key;
  return { lead, key };
}

// A LIST item through the placer (`engine-place.ts`): one stack of its
// number (a list of two or more items), its lead-in (when it has one) and its
// key phrase, from the entry the LIST was picked with (`list/numbered`),
// placed once as a whole over the texts on screen with it. The stack's box
// becomes the levels' positions (each centred on the stack, `align` center),
// sizes and `breaks`, and joins `shown` for the item's whole span. False when
// no candidate keeps the hard rules: the item is left out (see the loop).
export function placeStack(pass: Pass, plan: TransitionPlan): boolean {
  const { preset, picked, measurer, record, shown, transitionItems, range } = pass;
  const { choice, label, number } = plan;
  const ids = range(choice.from, choice.to);
  const { lead, key } = levelTexts(pass, plan);
  const starts: Record<LevelRole, Anchor> = {
    number: plan.startAnchor,
    lead: { word: choice.from },
    key: { word: choice.key_from },
  };
  const element: StackElement = {
    type: "stack",
    id: plan.id,
    variant: stackVariantOf(picked),
    levels: [
      ...(number !== undefined ? [{ role: "number" as const, text: String(number) }] : []),
      ...(lead ? [{ role: "lead" as const, text: lead }] : []),
      { role: "key" as const, text: key },
    ],
    gap: preset.transition.gap,
    start: plan.start,
    end: plan.end,
  };
  const result = placeElement(element, sceneFor(pass, plan), measurer);
  record.push(...result.notes);
  if (!result.placed) return false;
  const { box } = result.placed;
  const levels: Partial<Record<LevelRole, TransitionLevel>> = {};
  const places = stackPositions(box, result.placed.levels, preset.transition.gap);
  for (const [index, level] of result.placed.levels.entries()) {
    const text = element.levels.find((entry) => entry.role === level.role)!.text;
    const { x, y } = places[index]!;
    levels[level.role] = {
      text,
      start: starts[level.role],
      position: { x, y, align: "left" },
      size: level.size,
      ...(level.lines.length > 1 ? { breaks: level.breaks } : {}),
    };
  }
  shown.push({
    id: plan.id,
    what: `the text of ${label}`,
    start: plan.start,
    end: plan.end,
    box,
  });
  transitionItems.set(plan.id, {
    index: plan.index,
    item: {
      id: plan.id,
      type: "numbered",
      start: plan.startAnchor,
      end: plan.endAnchor,
      words: ids,
      key: choice.key_from,
      list: plan.list,
      ...(number !== undefined ? { number } : {}),
      levels: { ...levels, key: levels.key! },
    },
  });
  return true;
}

// A caption block through the placer (`engine-place.ts`): the element of the
// entry captions were picked with (`caption/default`: beside the face, below
// it, the caption line, anywhere in the safe zone; the `caption` style, 50 px
// at most), its groups the captions left in each group of the sentence (a
// caption a text shows while it is on screen, `hidden_by`, has no place and
// takes no room), its id its first caption's, over the components and the
// captions placed before it (`shown`; a caption among them is a `caption`
// obstacle, rule 2). The block's size is the largest at which every group
// fits (decision 4), shrunk in 10% steps to 30 px; its lines are free; the
// face is a cost; text is never covered (rule 5, hard). Each caption's place
// is its line's, the lines centred in the block's box; every caption of the
// block gets the block's notes under its own id (the checks read them per
// caption). Captions are never left out (rule 3, decision 19): a block with
// no legal spot at 30 px or more is placed again with the texts on screen
// out of its way (rule 5 alone given up, never the safe zone; the face still
// a cost), noted `no-spot` with the texts that took the space and the ones it
// sits over as blockers; the `text-overlap` check excuses exactly those pairs.
// Settled: the fallback scene keeps nothing but the notch and the face as
// obstacles (captions never share a moment with another sentence's, so a
// caption obstacle is none in practice); a block that fits nowhere even then
// (a caption group wider or taller than the safe zone at 30 px) is an error,
// not a layout.
export function placeCaptions(pass: Pass, block: CaptionBlock): void {
  const captionFont = STYLES.caption.font;
  const { preset, picked, measurer, record, shown, placedCaptions, unitEnd } = pass;
  const first = block.groups[0]![0]!;
  const label = block.groups
    .flat()
    .map((unit) => unit.text)
    .join(" ");
  const element: BlockElement = {
    type: "block",
    id: first.caption.id,
    variant: textVariantOf(picked, "CAPTION"),
    groups: block.groups.map((group) =>
      group.map((unit) => ({
        id: unit.caption.id,
        text: unit.text,
        ...(unit.caption.font ? { font: unit.caption.font } : {}),
      })),
    ),
    lineGap: preset.caption.lineGap,
    start: block.start,
    end: block.end,
  };
  const scene = sceneFor(pass, block);
  const legal = placeElement(element, scene, measurer);
  let placed = legal.placed;
  let notes = legal.notes;
  if (!placed) {
    const over = placeElement(element, { ...scene, obstacles: [] }, measurer);
    if (!over.placed) {
      throw new Error(
        `engine: captions ${quote(label)} (${at(block.start)} to ${at(block.end)}) fit nowhere in the safe zone at ${MIN_SIZE_PX} px`,
      );
    }
    placed = over.placed;
    const under = textsOver(shown, placed.box, block);
    const named = [...new Set(under.map((item) => item.what))].join(" and ");
    const taken = legal.notes.find((note) => note.outcome === "no-spot")!;
    const blockers = [...taken.blockers];
    for (const item of under) {
      const blocker = item.caption
        ? { kind: "caption" as const, id: item.id }
        : { kind: "item" as const, id: item.id };
      if (!blockers.some((known) => JSON.stringify(known) === JSON.stringify(blocker))) {
        blockers.push(blocker);
      }
    }
    notes = [
      {
        ...taken,
        blockers,
        zone: placed.zone,
        size: placed.size,
        lines: placed.lines.length,
        cost: placed.cost,
        reason: `${taken.reason}; every caption stays on screen, so it sits over ${named || "nothing"} at ${placed.size} px, inside the safe zone`,
      },
      ...over.notes.filter((note) => note.outcome !== "placed"),
    ];
  }
  for (const unit of block.groups.flat()) {
    for (const note of notes) record.push({ ...note, item: unit.caption.id });
  }
  const { box, size, groups } = placed;
  const width = box.right - box.left;
  // Each group's lines at their places inside the block: each caption's
  // corner, and its box as shown (so the captions after it avoid it).
  const space = measurer.width(captionFont, size, " ");
  block.groups.forEach((group, index) => {
    let next = 0;
    let y = box.top;
    for (const line of groups[index]!) {
      let x = box.left + (width - line.width) / 2;
      for (const { width: unitWidth } of line.units) {
        const unit = group[next++]!;
        const left = Math.floor(x * 100) / 100;
        placedCaptions.set(unit.index, { x: left, y, size });
        shown.push({
          id: unit.caption.id,
          what: `caption ${quote(unit.text)}`,
          start: unit.start,
          end: unitEnd.get(unit.index)!,
          box: { left, right: left + unitWidth, top: y, bottom: y + size },
          caption: true,
        });
        x += unitWidth + space;
      }
      y += size + preset.caption.lineGap;
    }
  });
}

// An accent or a question through the placer (`engine-place.ts`): the
// element from the entry its component was picked with (`accent/above-head`,
// `question/as-accent`), the scene from the moments of its span (the robust
// faces, unpadded; every component on screen with it placed before it as an
// obstacle; captions come last and are none yet). Its position, size and
// `breaks` are the placer's; the notes go to the record as they are. False
// when no candidate keeps the hard rules: the element is left out (see
// `placeExtra`).
function placeAccent(pass: Pass, extra: Extra, span: { start: number; end: number }): boolean {
  const { transcript, preset, picked, measurer, record, shown, overlays, range } = pass;
  const accent = extra.accent!;
  const ids = range(accent.from, accent.to);
  const text = wordsText(ids, transcript, preset);
  const element: TextElement = {
    type: "text",
    id: extra.id,
    variant: textVariantOf(picked, accent.question ? "QUESTION" : "ACCENT"),
    text,
    lineGap: 0,
    start: span.start,
    end: span.end,
  };
  const result = placeElement(element, sceneFor(pass, span), measurer);
  record.push(...result.notes);
  if (!result.placed) return false;
  const { box, size, lines, breaks } = result.placed;
  overlays.set(extra.id, {
    id: extra.id,
    kind: "accent",
    start: startAnchorOf(pass, accent.from, span.start),
    end: { word: accent.to, edge: "end" },
    words: ids,
    position: { x: box.left, y: box.top, align: "left" },
    size,
    ...(lines.length > 1 ? { breaks } : {}),
  });
  shown.push({
    id: extra.id,
    what: `${accentNoun(accent)} ${quote(text)}`,
    start: span.start,
    end: span.end,
    box,
  });
  return true;
}

// The written hook through the placer: the element of the entry it was
// picked with (`hook/written-line`: the upper third, then anywhere in the
// safe zone, the accent style), over its whole window, around whatever is
// on screen with it. Its position, size and `breaks` are the placer's. False
// when no candidate keeps the hard rules (settled: a hook that fits nowhere
// at 30 px or more is a `no-spot` like any element, left out of the version;
// nobody says it, so no caption stands in for it).
function placeHook(pass: Pass, extra: Extra, span: { start: number; end: number }): boolean {
  const { transcript, picked, measurer, record, shown, overlays } = pass;
  const text = extra.hook!.text;
  const element: TextElement = {
    type: "text",
    id: extra.id,
    variant: textVariantOf(picked, "HOOK"),
    text,
    lineGap: 0,
    start: span.start,
    end: span.end,
  };
  const result = placeElement(element, sceneFor(pass, span), measurer);
  record.push(...result.notes);
  if (!result.placed) return false;
  const { box, size, lines, breaks } = result.placed;
  overlays.set(extra.id, {
    id: extra.id,
    kind: "hook",
    text,
    start: anchorAt(span.start, transcript.words),
    end: anchorAt(span.end, transcript.words),
    position: { x: box.left, y: box.top, align: "left" },
    size,
    ...(lines.length > 1 ? { breaks } : {}),
  });
  shown.push({ id: extra.id, what: describe(pass, extra), start: span.start, end: span.end, box });
  return true;
}

// The big word through the placer: the element of the entry it was picked
// with (`bigword/behind`: the `head-top` zone, the `bigWord` style, the
// largest fit anchored at the head top, the behind layer), on one line (the
// behind word item carries no `breaks`), over the texts on screen with it.
// The face is no obstacle to it (it sits behind the speaker by design); rule
// 6, the face hiding at most 30% of its height, is the placer's hard filter,
// and the word stays inside the safe zone S like every text (decision 2). A word
// that needs the cut-out keeps off every visual card (decision 24; the placer's
// `cutout` predicate and `box` obstacles), and joins `shown` as `behind`, so a
// card placed after it keeps off it too; a word with no cut-out is front text.
// Its position and size are the placer's; the notes go to the record as they
// are. Its `cutout` is whether the head reaches it over its padded span
// (`bigWordNeedsCutout`): a word above the head needs no cut-out. False when no
// candidate keeps the hard rules: the word is left out (see `placeExtra`).
function placeBigWord(pass: Pass, extra: Extra, span: { start: number; end: number }): boolean {
  const { transcript, picked, measurer, record, shown, behind, word, range } = pass;
  const { headTrack, duration, preset } = pass;
  const first = word(extra.word!);
  const text = bigWordText(pass, extra.word!, extra.wordTo!);
  const element: TextElement = {
    type: "text",
    id: extra.id,
    variant: textVariantOf(picked, "BIGWORD"),
    text,
    lineGap: 0,
    maxLines: 1,
    start: span.start,
    end: span.end,
  };
  const padded = paddedSpan(span, duration, preset);
  const scene = {
    ...sceneFor(pass, span),
    cutout: (at: Box) => bigWordNeedsCutout(at, headTrack, padded),
  };
  const result = placeElement(element, scene, measurer);
  record.push(...result.notes);
  if (!result.placed) return false;
  const { box, size } = result.placed;
  const cutout = bigWordNeedsCutout(box, headTrack, padded);
  behind.set(extra.id, {
    id: extra.id,
    kind: "word",
    text,
    start: startAnchorOf(pass, first.id, span.start),
    end: anchorAt(
      span.end,
      transcript.words.filter((w) => w.start >= first.start),
    ),
    position: { x: box.left, y: box.top },
    size,
    words: range(extra.word!, extra.wordTo!),
    cutout,
  });
  // A big word that needs the cut-out is `behind` (a card keeps off it); one that
  // does not is plain text over the footage (a card may sit under it).
  shown.push({
    id: extra.id,
    what: describe(pass, extra),
    start: span.start,
    end: span.end,
    box,
    ...(cutout ? { kind: "behind" as const } : {}),
  });
  return true;
}

// A visual's card through the placer: the box element of the entry it was
// picked with (`visual/card`: a corner of S, then beside the face; its full
// width its `width` share of the frame, 360 px, and its height the stand-in
// picture's own aspect, so 360 by 450 px for a 4:5 picture, shrunk from there
// in 10% steps where the spot is smaller), an empty white stroke frame in front
// of the speaker, over the footage, showing the picture the extra was given
// (`VISUAL_STAND_INS`). The face is a cost (100),
// so the card covers it only as a last resort (noted `covers-face`). Text is no
// obstacle to the card (decision 9: a text may sit on a card, the card draws
// under it): the card sees the notch, the face and the big words on screen, and
// joins `shown` as a `box` for the big words placed after it (decision 24: a
// card never sits on a big word behind the speaker). Its box and the notes are
// the placer's.
// False when no candidate keeps the hard rules: the card is left out (see
// `placeExtra`).
function placeVisual(pass: Pass, extra: Extra, span: { start: number; end: number }): boolean {
  const { transcript, picked, measurer, record, shown, behind, word, sentenceOf } = pass;
  const visual = extra.visual!;
  const image = extra.image!;
  const element: BoxElement = {
    type: "box",
    id: extra.id,
    variant: boxVariantOf(picked),
    aspect: image.width / image.height,
    start: span.start,
    end: span.end,
  };
  const result = placeElement(element, sceneFor(pass, span), measurer);
  record.push(...result.notes);
  if (!result.placed) return false;
  const { box } = result.placed;
  shown.push({
    id: extra.id,
    what: describe(pass, extra),
    start: span.start,
    end: span.end,
    box,
    kind: "box",
  });
  const sentence = sentenceOf(visual.from)!;
  behind.set(extra.id, {
    id: extra.id,
    kind: "visual",
    ...(visual.description ? { description: visual.description } : {}),
    image: image.file,
    box: {
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
    },
    start:
      Math.abs(span.start - sentence.start) < 0.0005
        ? { word: sentence.from }
        : Math.abs(span.start - word(visual.from).start) < 0.0005
          ? { word: visual.from }
          : anchorAt(span.start, transcript.words),
    end: anchorAt(span.end, transcript.words),
  });
  return true;
}
