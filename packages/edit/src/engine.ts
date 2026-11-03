import { spotBox, spotFaceShare } from "./behind.ts";
import type { AccentChoice, EngineInput, Wish } from "./engine-input.ts";
import { expand, overlaps, placeBox } from "./engine-space.ts";
import { type Box, type HeadTrack, LAYOUT_PADDING, boundingBox, facesOver } from "./head-track.ts";
import { wordsText } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import {
  BEHIND_SPOTS,
  type BehindSpot,
  type FontKey,
  PLATFORM_BUTTONS,
  type Preset,
  cleanWord,
} from "./preset.ts";
import type {
  Anchor,
  BehindItem,
  CaptionItem,
  Edit,
  OverlayItem,
  TransitionItem,
} from "./schema.ts";
import { resolveAnchor } from "./timeline.ts";
import { type SentenceSpan, type Transcript, type Word, sentenceSpans } from "./transcript.ts";

// THE LAYOUT ENGINE. Claude's answer says what and on which words; this code
// decides every time, position and size, with no randomness and no I/O:
//
// 1. Timing first: captions per spoken word, an accent from its first word
//    to a second after its last, the big word from its word to the end of its
//    sentence, a photo over its sentence, each at least its minimum.
// 2. The scene: the reel cut into moments wherever an item starts or ends,
//    each with its face (robust over the head track, never one reading).
// 3. Free space: an area minus the face, the platform notch and the text
//    already placed, as rectangles (`engine-space.ts`).
// 4. Placement by priority: captions (one spot per sentence), then the items
//    the request is about, accents, the big word, photos; at most one of
//    these extras at a time. Text shrinks to the preset's floor and wraps to
//    two lines before it gives up a place. Nothing ever overlaps.
// 5. An extra that fits nowhere is dropped; captions never are (in the worst
//    case they take the caption line over the face).
// 6. Every move, shrink, wrap, retime or drop is written to the record.

// What the engine did to an item, in plain words.
export type EngineAction =
  "moved" | "shrunk" | "wrapped" | "retimed" | "dropped" | "covers-face" | "wish-not-kept";

export interface EngineNote {
  item: string;
  action: EngineAction;
  rule: string;
  reason: string;
}

export type PlacedTracks = Omit<Edit["tracks"], "cutout">;

export interface Placement {
  tracks: PlacedTracks;
  record: EngineNote[];
}

export interface PlaceOptions {
  // The answer items the owner's request asks for (`accents[0]`, `big_word`,
  // `photos[1]`): placed before every other extra.
  requested?: readonly string[];
}

type Align = "left" | "right" | "center";

interface Shown {
  id: string;
  start: number;
  end: number;
  box: Box;
}

const SLACK = 1e-6;

function ms(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

function at(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 37)}...` : text);
}

function during(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end - SLACK && b.start < a.end - SLACK;
}

// An anchor at `t`: the nearest word end within a second (with the offset),
// else the time itself.
function anchorAt(t: number, words: readonly Word[]): Anchor {
  let best: Word | null = null;
  for (const word of words) {
    if (Math.abs(t - word.end) > 1) continue;
    if (!best || Math.abs(t - word.end) < Math.abs(t - best.end)) best = word;
  }
  if (!best) return { time: ms(t) };
  const offset = ms(t - best.end);
  return offset === 0 ? { word: best.id, edge: "end" } : { word: best.id, edge: "end", offset };
}

// The sizes a text tries, from its own down to the preset's floor.
function sizesFrom(size: number, preset: Preset): number[] {
  const floor = Math.ceil(size * preset.layout.minScale);
  const out: number[] = [];
  for (let step = 0; ; step += 1) {
    const next = Math.round(size * (1 - step * 0.1));
    if (next < floor) break;
    if (!out.includes(next)) out.push(next);
  }
  if (!out.includes(floor)) out.push(floor);
  return out;
}

// ---------------------------------------------------------------- the scene

interface Moment {
  start: number;
  end: number;
  // The face (padded for text) over the moment; null with no head.
  face: Box | null;
}

// The reel cut at every item edge; each moment's face is the bounding box of
// the robust faces around it.
function sceneOf(edges: readonly number[], duration: number, headTrack: HeadTrack): Moment[] {
  const cuts = [...new Set([0, ms(duration), ...edges.map(ms)])]
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b);
  const moments: Moment[] = [];
  for (let index = 1; index < cuts.length; index += 1) {
    const start = cuts[index - 1]!;
    const end = cuts[index]!;
    const face = boundingBox(facesOver(headTrack, start - 0.25, end + 0.25, LAYOUT_PADDING));
    moments.push({ start, end, face });
  }
  return moments;
}

function facesDuring(scene: readonly Moment[], span: { start: number; end: number }): Box[] {
  const out: Box[] = [];
  for (const moment of scene) {
    if (moment.face && moment.start < span.end && span.start < moment.end) out.push(moment.face);
  }
  return out;
}

// ---------------------------------------------------------------- captions

interface Unit {
  index: number;
  caption: CaptionItem;
  text: string;
  start: number;
  lastWord: Word;
}

interface CaptionBlock {
  kind: "sentence" | "transition";
  groups: Unit[][];
  start: number;
  end: number;
  transition?: TransitionItem;
}

// The current captions as groups (one set of words on screen: consecutive
// captions ending on the same anchor), re-timed: a group leaves at its last
// word's end, held so its last caption shows at least the preset's minimum,
// never past the next group's start; a last caption that cannot show that
// long joins the next group.
function captionGroups(
  captions: readonly CaptionItem[],
  texts: readonly string[],
  transcript: Transcript,
  duration: number,
  preset: Preset,
  record: EngineNote[],
): { groups: Unit[][]; ends: number[] } {
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const groups: Unit[][] = [];
  let key = "";
  captions.forEach((caption, index) => {
    const unit: Unit = {
      index,
      caption,
      text: texts[index]!,
      start: resolveAnchor(caption.start, words, duration),
      lastWord: words.get(caption.words.at(-1)!)!,
    };
    const end = JSON.stringify(caption.end);
    const last = groups.at(-1);
    if (last && end === key) last.push(unit);
    else groups.push([unit]);
    key = end;
  });
  const min = preset.caption.minSeconds;
  for (let index = groups.length - 2; index >= 0; index -= 1) {
    const group = groups[index]!;
    const next = groups[index + 1]!;
    while (group.length > 0 && next[0]!.start - group.at(-1)!.start < min - SLACK) {
      const moved = group.pop()!;
      next.unshift(moved);
      record.push({
        item: moved.caption.id,
        action: "retimed",
        rule: "caption-min",
        reason: `caption ${quote(moved.text)} joins the next group, so it shows at least ${min} s`,
      });
    }
    if (group.length === 0) groups.splice(index, 1);
  }
  const ends = groups.map((group, index) => {
    const lastWord = group.at(-1)!.lastWord;
    const next = groups[index + 1]?.[0]?.start ?? duration;
    const end = ms(Math.min(next, duration, Math.max(lastWord.end, group.at(-1)!.start + min)));
    if (end > lastWord.end + 0.0005) {
      record.push({
        item: group.at(-1)!.caption.id,
        action: "retimed",
        rule: "caption-min",
        reason: `caption ${quote(group.at(-1)!.text)} stays until ${at(end)}, at least ${min} s on screen`,
      });
    }
    return end;
  });
  return { groups, ends };
}

interface Candidate {
  name: string;
  area: Box;
  align: Align;
  want: (width: number, height: number) => { x: number; y: number };
  maxLines: number;
  // The worst case: the face is no obstacle.
  overFace?: boolean;
}

interface Line {
  units: { unit: Unit; width: number }[];
  width: number;
}

function wrapUnits(
  units: readonly Unit[],
  font: FontKey,
  size: number,
  width: number,
  maxLines: number,
  measurer: Measurer,
): Line[] | null {
  const space = measurer.width(font, size, " ");
  const lines: Line[] = [];
  for (const unit of units) {
    const w = measurer.width(unit.caption.font ?? font, size, unit.text);
    if (w > width) return null;
    const line = lines.at(-1);
    if (line && line.width + space + w <= width) {
      line.units.push({ unit, width: w });
      line.width += space + w;
    } else {
      lines.push({ units: [{ unit, width: w }], width: w });
      if (lines.length > maxLines) return null;
    }
  }
  return lines;
}

// ---------------------------------------------------------------- the engine

interface Extra {
  ref: string;
  kind: "accent" | "big_word" | "photo";
  id: string;
  start: number;
  end: number;
  min: number;
  wish?: Wish;
}

interface Accepted {
  extra: Extra;
  start: number;
  end: number;
}

// Places every item of an answer over the current version: footage and
// sounds kept, captions from the current version's words (each fix as the
// text of the caption showing that word), every other item from its words.
export function placeEdit(
  current: Edit,
  input: EngineInput,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  options: PlaceOptions = {},
): Placement {
  const record: EngineNote[] = [];
  const duration = current.duration;
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const word = (id: string) => byId.get(id)!;
  const order = new Map(transcript.words.map((w, index) => [w.id, index]));
  const range = (from: string, to: string) =>
    transcript.words.slice(order.get(from)!, order.get(to)! + 1).map((w) => w.id);
  const sentences = sentenceSpans(transcript);
  const sentenceOf = (id: string): SentenceSpan | undefined => {
    const index = order.get(id)!;
    return sentences.find((s) => order.get(s.from)! <= index && index <= order.get(s.to)!);
  };
  const { safe, layout } = preset;
  const gap = layout.gap;
  const notch = PLATFORM_BUTTONS;
  const safeCx = (safe.left + safe.right) / 2;
  const hidden = current.tracks.footage.flatMap((clip) =>
    (clip.hidden ?? []).map((span) => ({
      start: resolveAnchor(span.start, byId, duration),
      end: resolveAnchor(span.end, byId, duration),
    })),
  );

  // Fixes, then the captions' times.
  const fixes = new Map(input.word_fixes.map((fix) => [fix.word, fix.text]));
  const captions = current.tracks.captions.map((caption) => {
    const rest: CaptionItem = { ...caption };
    delete rest.text;
    delete rest.position;
    delete rest.size;
    delete rest.break_after;
    const fixed = caption.words.filter((id) => fixes.has(id)).map((id) => fixes.get(id)!);
    return fixed.length > 0 ? { ...rest, text: fixed.join(" ") } : rest;
  });
  const texts = captions.map(
    (caption) => caption.text ?? wordsText(caption.words, transcript, preset),
  );
  const { groups, ends } = captionGroups(captions, texts, transcript, duration, preset, record);
  const unitEnd = new Map<number, number>();
  const unitEndWord = new Map<number, Word>();
  groups.forEach((group, index) => {
    for (const unit of group) {
      unitEnd.set(unit.index, ends[index]!);
      unitEndWord.set(unit.index, group.at(-1)!.lastWord);
    }
  });

  const transitions: TransitionItem[] = input.transitions.map((transition, index) => ({
    id: `transition-${index + 1}`,
    type: transition.kind,
    start: { word: transition.from },
    end: { word: transition.to, edge: "end" as const },
  }));
  const transitionSpans = transitions.map((item) => ({
    item,
    start: resolveAnchor(item.start, byId, duration),
    end: resolveAnchor(item.end, byId, duration),
  }));

  // The extras' own times (before the one-at-a-time rule).
  const extras: Extra[] = [];
  let accentCount = 0;
  const accentIds = input.accents.map((accent) =>
    accent.title ? "title" : `accent-${++accentCount}`,
  );
  input.accents.forEach((accent, index) => {
    const id = accentIds[index]!;
    const start = word(accent.from).start;
    const end = ms(
      Math.min(
        duration,
        Math.max(
          word(accent.to).end + preset.accent.afterSeconds,
          start + preset.accent.minSeconds,
        ),
      ),
    );
    if (end - start < preset.accent.minSeconds - SLACK) {
      record.push({
        item: id,
        action: "dropped",
        rule: "accent-time",
        reason: `accent ${quote(accentText(accent))} starts too close to the end to show ${preset.accent.minSeconds} s`,
      });
      return;
    }
    extras.push({
      ref: `accents[${index}]`,
      kind: "accent",
      id,
      start,
      end,
      min: preset.accent.minSeconds,
      ...(accent.wish ? { wish: accent.wish } : {}),
    });
  });
  const { minSeconds, maxSeconds } = preset.behind;
  const crossesHidden = (span: { start: number; end: number }) =>
    hidden.some((range) => during(span, range));
  if (input.big_word) {
    const first = word(input.big_word.word);
    const sentence = sentenceOf(first.id);
    const end = ms(
      Math.min(
        duration,
        first.start + maxSeconds,
        Math.max(first.start + minSeconds, sentence?.end ?? first.end),
      ),
    );
    const text = cleanWord(first.text, preset);
    if (end - first.start < minSeconds - SLACK) {
      record.push({
        item: "big-word",
        action: "dropped",
        rule: "big-word-time",
        reason: `the big word ${quote(text)} is said too close to the end to show ${minSeconds} s`,
      });
    } else if (crossesHidden({ start: first.start, end })) {
      record.push({
        item: "big-word",
        action: "dropped",
        rule: "hidden-footage",
        reason: `the big word ${quote(text)} would show while the footage is hidden`,
      });
    } else {
      extras.push({
        ref: "big_word",
        kind: "big_word",
        id: "big-word",
        start: first.start,
        end,
        min: minSeconds,
        ...(input.big_word.wish ? { wish: input.big_word.wish } : {}),
      });
    }
  }
  input.photos.forEach((photo, index) => {
    const id = `photo-${index + 1}`;
    const sentence = sentenceOf(photo.from)!;
    const at0 = sentences.indexOf(sentence);
    const lo = sentences[at0 - 1]?.end ?? 0;
    const hi = Math.min(duration, sentences[at0 + 1]?.start ?? duration);
    // From the sentence's start; in a long sentence whose photo words come
    // later, from its first word, so it still shows over its own words.
    const first = word(photo.from);
    let start = first.start - sentence.start > 1 ? first.start : sentence.start;
    let end = Math.min(start + maxSeconds, Math.max(sentence.end, start + minSeconds));
    if (end > hi + SLACK) {
      end = hi;
      start = Math.max(lo, hi - minSeconds);
    }
    start = ms(start);
    end = ms(end);
    if (end - start < minSeconds - SLACK) {
      record.push({
        item: id,
        action: "dropped",
        rule: "photo-time",
        reason: `photo ${index + 1}: its sentence and the pauses around it last under ${minSeconds} s`,
      });
      return;
    }
    if (crossesHidden({ start, end })) {
      record.push({
        item: id,
        action: "dropped",
        rule: "hidden-footage",
        reason: `photo ${index + 1} would show while the footage is hidden`,
      });
      return;
    }
    if (start < Math.min(sentence.start, first.start) - SLACK) {
      record.push({
        item: id,
        action: "retimed",
        rule: "photo-time",
        reason: `photo ${index + 1} starts at ${at(start)}, before its short sentence, to show ${minSeconds} s`,
      });
    }
    extras.push({
      ref: `photos[${index}]`,
      kind: "photo",
      id,
      start,
      end,
      min: minSeconds,
      ...(photo.wish ? { wish: photo.wish } : {}),
    });
  });

  // The scene: every edge of every item.
  const scene = sceneOf(
    [
      ...captions.map((_, index) => unitStart(index)),
      ...ends,
      ...transitionSpans.flatMap((span) => [span.start, span.end]),
      ...extras.flatMap((extra) => [extra.start, extra.end]),
    ],
    duration,
    headTrack,
  );
  function unitStart(index: number): number {
    return resolveAnchor(captions[index]!.start, byId, duration);
  }
  const faceObstacles = (span: { start: number; end: number }) =>
    facesDuring(scene, span).map((face) => ({
      ...face,
      top: face.top - gap,
      bottom: face.bottom + gap,
    }));
  const shown: Shown[] = [];
  const textDuring = (span: { start: number; end: number }) =>
    shown.filter((item) => during(item, span)).map((item) => expand(item.box, gap));

  // Captions: blocks in time order, each a sentence's groups (one spot for the
  // whole sentence) or the captions inside a transition (its text area).
  const blocks: CaptionBlock[] = [];
  const sentenceBlocks = new Map<SentenceSpan | undefined, CaptionBlock>();
  const transitionBlocks = new Map<TransitionItem, CaptionBlock>();
  groups.forEach((group, index) => {
    const end = ends[index]!;
    const outside: Unit[] = [];
    for (const unit of group) {
      const inside = transitionSpans.find(
        (span) => unit.start >= span.start - SLACK && unit.start < span.end - SLACK,
      );
      if (!inside) {
        outside.push(unit);
        continue;
      }
      let block = transitionBlocks.get(inside.item);
      if (!block) {
        block = {
          kind: "transition",
          groups: [[]],
          start: unit.start,
          end,
          transition: inside.item,
        };
        transitionBlocks.set(inside.item, block);
        blocks.push(block);
      }
      block.groups[0]!.push(unit);
      block.end = Math.max(block.end, end);
    }
    if (outside.length === 0) return;
    const sentence = sentenceOf(outside[0]!.caption.words[0]!);
    let block = sentenceBlocks.get(sentence);
    if (!block) {
      block = { kind: "sentence", groups: [], start: outside[0]!.start, end };
      sentenceBlocks.set(sentence, block);
      blocks.push(block);
    }
    block.groups.push(outside);
    block.end = Math.max(block.end, end);
  });
  blocks.sort((a, b) => a.start - b.start);

  const captionFont = preset.caption.font;
  const placedCaptions = new Map<number, { x: number; y: number; size: number }>();
  const photoSpans = extras.filter((extra) => extra.kind === "photo");
  for (const block of blocks) {
    placeBlock(block);
  }

  function captionCandidates(block: CaptionBlock): Candidate[] {
    const faces = facesDuring(scene, block);
    const face = boundingBox(faces);
    const out: Candidate[] = [];
    if (block.transition) {
      const area = preset.transitions[block.transition.type].text;
      out.push({
        name: "in the transition's text area",
        area,
        align: "center",
        want: (w, h) => ({ x: (area.left + area.right) / 2, y: area.top + h / 2 }),
        maxLines: 20,
      });
    }
    const maxLines = block.kind === "transition" ? 20 : 2;
    const line: Candidate = {
      name: "on the caption line",
      area: { ...safe, top: preset.caption.fallbackY },
      align: "center",
      want: (w, h) => ({ x: safeCx, y: preset.caption.fallbackY + h / 2 }),
      maxLines,
    };
    if (face) {
      const top = Math.max(safe.top, face.top);
      const bottom = Math.min(safe.bottom, face.bottom + 120);
      const mouth = face.top + 0.7 * (face.bottom - face.top);
      const left: Candidate = {
        name: "beside the head on the left",
        area: { left: safe.left, right: face.left, top, bottom },
        align: "right",
        want: (w) => ({ x: face.left - w / 2, y: mouth }),
        maxLines,
      };
      const right: Candidate = {
        name: "beside the head on the right",
        area: { left: face.right, right: safe.right, top, bottom },
        align: "left",
        want: (w) => ({ x: face.right + w / 2, y: mouth }),
        maxLines,
      };
      const sides = safe.right - face.right > face.left - safe.left ? [right, left] : [left, right];
      out.push(...sides, {
        name: "below the face",
        area: { ...safe, top: face.bottom + gap },
        align: "center",
        want: (w, h) => ({
          x: Math.min(
            safe.right - w / 2,
            Math.max(safe.left + w / 2, (face.left + face.right) / 2),
          ),
          y: face.bottom + gap + h / 2,
        }),
        maxLines,
      });
      out.push(line);
    } else {
      out.push(line, {
        name: "in the safe zone",
        area: safe,
        align: "center",
        want: (w, h) => ({ x: safeCx, y: preset.caption.fallbackY + h / 2 }),
        maxLines,
      });
    }
    return out;
  }

  // Whether a caption box over a block leaves a photo of the same moment a spot.
  function leavesPhotoSpot(box: Box, span: { start: number; end: number }): boolean {
    const photos = photoSpans.filter((photo) => during(photo, span));
    return photos.every((photo) =>
      BEHIND_SPOTS.some(
        (spot) =>
          !overlaps(box, spotBox(spot, preset)) && spotClearOfFace(spot, photo, preset, headTrack),
      ),
    );
  }

  function tryBlock(
    block: CaptionBlock,
    candidate: Candidate,
    size: number,
    keepPhotoSpot: boolean,
  ): { x: number; y: number; width: number; layouts: Line[][] } | null {
    const areaWidth = candidate.area.right - candidate.area.left;
    if (areaWidth <= 0) return null;
    const layouts: Line[][] = [];
    let width = 0;
    let height = 0;
    for (const group of block.groups) {
      const lines = wrapUnits(group, captionFont, size, areaWidth, candidate.maxLines, measurer);
      if (!lines) return null;
      layouts.push(lines);
      width = Math.max(width, ...lines.map((line) => line.width));
      height = Math.max(height, lines.length * size + (lines.length - 1) * preset.caption.lineGap);
    }
    const obstacles = [
      ...(candidate.overFace ? [] : faceObstacles(block)),
      ...textDuring(block),
      notch,
    ];
    const spot = placeBox(candidate.area, obstacles, width, height, candidate.want(width, height));
    if (!spot) return null;
    const box = { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + height };
    if (keepPhotoSpot && !leavesPhotoSpot(box, block)) return null;
    return { ...spot, width, layouts };
  }

  function placeBlock(block: CaptionBlock): void {
    const candidates = captionCandidates(block);
    const sizes = sizesFrom(preset.fonts[captionFont].size, preset);
    const first = block.groups[0]![0]!;
    const label = block.groups
      .flat()
      .map((unit) => unit.text)
      .join(" ");
    let chosen: {
      candidate: Candidate;
      size: number;
      fit: NonNullable<ReturnType<typeof tryBlock>>;
    } | null = null;
    const holdsPhoto =
      block.kind === "sentence" && photoSpans.some((photo) => during(photo, block));
    // Captions stay readable first: every place at the full size before any
    // smaller size.
    for (const keep of holdsPhoto ? [true, false] : [false]) {
      for (const size of sizes) {
        for (const candidate of candidates) {
          const fit = tryBlock(block, candidate, size, keep);
          if (fit) {
            chosen = { candidate, size, fit };
            break;
          }
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    if (!chosen) {
      const floor = sizes.at(-1)!;
      for (const area of [{ ...safe, top: preset.caption.fallbackY }, safe]) {
        const worst: Candidate = {
          name: "on the caption line over the face",
          area,
          align: "center",
          want: (w, h) => ({ x: safeCx, y: area.top + h / 2 }),
          maxLines: 20,
          overFace: true,
        };
        const fit = tryBlock(block, worst, floor, false);
        if (fit) {
          chosen = { candidate: worst, size: floor, fit };
          break;
        }
      }
      if (!chosen) {
        // Larger than the safe zone at the floor: one unit per line from its
        // top (never reached at the preset's sizes).
        const layouts = block.groups.map((group) =>
          group.map((unit) => {
            const w = measurer.width(captionFont, floor, unit.text);
            return { units: [{ unit, width: w }], width: w };
          }),
        );
        chosen = {
          candidate: {
            name: "at the top of the safe zone over everything",
            area: safe,
            align: "left",
            want: () => ({ x: safe.left, y: safe.top }),
            maxLines: 99,
            overFace: true,
          },
          size: floor,
          fit: { x: safe.left, y: safe.top, width: safe.right - safe.left, layouts },
        };
      }
      record.push({
        item: first.caption.id,
        action: "covers-face",
        rule: "caption-face",
        reason: `captions ${quote(label)} (${at(block.start)} to ${at(block.end)}) found no free place and sit ${chosen.candidate.name}`,
      });
    } else if (chosen.candidate !== candidates[0]) {
      record.push({
        item: first.caption.id,
        action: "moved",
        rule: "caption-spot",
        reason: `captions ${quote(label)} (${at(block.start)} to ${at(block.end)}) sit ${chosen.candidate.name}: no room ${candidates[0]!.name}`,
      });
    }
    const { candidate, size, fit } = chosen;
    const fullSize = preset.fonts[captionFont].size;
    if (size < fullSize) {
      record.push({
        item: first.caption.id,
        action: "shrunk",
        rule: "caption-size",
        reason: `captions ${quote(label)} set at ${size} px instead of ${fullSize} px to fit`,
      });
    }
    const space = measurer.width(captionFont, size, " ");
    for (const lines of fit.layouts) {
      let y = fit.y;
      for (const line of lines) {
        let x =
          candidate.align === "left"
            ? fit.x
            : candidate.align === "right"
              ? fit.x + fit.width - line.width
              : fit.x + (fit.width - line.width) / 2;
        for (const { unit, width } of line.units) {
          const left = Math.floor(x * 100) / 100;
          placedCaptions.set(unit.index, { x: left, y, size });
          shown.push({
            id: unit.caption.id,
            start: unit.start,
            end: unitEnd.get(unit.index)!,
            box: { left, right: left + width, top: y, bottom: y + size },
          });
          x += width + space;
        }
        y += size + preset.caption.lineGap;
      }
    }
  }

  // The extras by priority, at most one at a time.
  const requested = options.requested ?? [];
  const rank = (extra: Extra) => {
    const asked = requested.indexOf(extra.ref);
    const kind = { accent: 1, big_word: 2, photo: 3 }[extra.kind];
    return asked >= 0 ? asked - 1000 : kind * 100;
  };
  const queue = extras
    .map((extra, index) => ({ extra, index }))
    .sort((a, b) => rank(a.extra) - rank(b.extra) || a.index - b.index)
    .map(({ extra }) => extra);
  const accepted: Accepted[] = [];
  const overlays = new Map<string, OverlayItem>();
  const behind = new Map<string, BehindItem>();
  for (const extra of queue) {
    const timed = fitTime(extra, accepted);
    if (!timed.ok) {
      record.push({
        item: extra.id,
        action: "dropped",
        rule: "one-extra",
        reason: `${describe(extra)} would show at the same time as ${describe(timed.with.extra)} (${at(extra.start)} to ${at(extra.end)}); one extra at a time`,
      });
      continue;
    }
    const span = { start: extra.start, end: timed.end };
    // The earlier extras it cuts short leave before it comes in, so they are
    // no obstacle; put back when it is not placed.
    const cut = timed.trims.map((trim) => ({
      trim,
      item: shown.find((item) => item.id === trim.accepted.extra.id),
    }));
    const kept = cut.map(({ item }) => item?.end);
    for (const { trim, item } of cut) if (item) item.end = trim.end;
    const placed =
      extra.kind === "accent"
        ? placeAccent(extra, span)
        : extra.kind === "big_word"
          ? placeBigWord(extra, span)
          : placePhoto(extra, span);
    if (!placed) {
      cut.forEach(({ item }, index) => {
        if (item) item.end = kept[index]!;
      });
      continue;
    }
    for (const trim of timed.trims) {
      trim.accepted.end = trim.end;
      record.push({
        item: trim.accepted.extra.id,
        action: "retimed",
        rule: "one-extra",
        reason: `${describe(trim.accepted.extra)} leaves at ${at(trim.end)}, when ${describe(extra)} needs the space`,
      });
    }
    if (timed.end < extra.end - SLACK) {
      record.push({
        item: extra.id,
        action: "retimed",
        rule: "one-extra",
        reason: `${describe(extra)} leaves at ${at(timed.end)}, before ${describe(timed.before!.extra)} comes in`,
      });
    }
    accepted.push({ extra, start: span.start, end: span.end });
  }

  function describe(extra: Extra): string {
    if (extra.kind === "accent") {
      const index = Number(/\d+/.exec(extra.ref)![0]);
      const accent = input.accents[index]!;
      return `${accent.title ? "the title" : "accent"} ${quote(accentText(accent))}`;
    }
    if (extra.kind === "big_word") {
      return `the big word ${quote(cleanWord(word(input.big_word!.word).text, preset))}`;
    }
    return `photo ${extra.id.replace("photo-", "")}`;
  }

  function accentText(accent: AccentChoice): string {
    return wordsText(range(accent.from, accent.to), transcript, preset);
  }

  function placeAccent(extra: Extra, span: { start: number; end: number }): boolean {
    const index = Number(/\d+/.exec(extra.ref)![0]);
    const accent = input.accents[index]!;
    const ids = range(accent.from, accent.to);
    const text = wordsText(ids, transcript, preset);
    const font = preset.accent.font;
    const fullSize = preset.fonts[font].size;
    const faces = facesDuring(scene, span);
    const face = boundingBox(faces);
    const bodies = faces.map((f) => {
      const width = f.right - f.left;
      return {
        left: f.left - width * 0.4,
        right: f.right + width * 0.4,
        top: f.bottom,
        bottom: preset.frame.height,
      };
    });
    const mid = (safe.top + safe.bottom) / 2;
    const areas: Record<string, Candidate> = {
      above: {
        name: "above the head",
        area: { ...safe, bottom: face ? face.top - gap : safe.top },
        align: "center",
        want: (w, h) => ({
          x: safeCx,
          y: face ? Math.max(safe.top + h / 2, face.top - preset.accent.aboveHead + h / 2) : 0,
        }),
        maxLines: 2,
      },
      top: {
        name: "in the upper part of the frame",
        area: { ...safe, bottom: mid },
        align: "center",
        want: (w, h) => ({ x: safeCx, y: safe.top + h / 2 }),
        maxLines: 2,
      },
      bottom: {
        name: "in the lower part of the frame",
        area: { ...safe, top: mid },
        align: "center",
        want: (w, h) => ({ x: safeCx, y: safe.bottom - h / 2 }),
        maxLines: 2,
      },
      left: {
        name: "on the left",
        area: { ...safe, right: safeCx },
        align: "center",
        want: (w) => ({ x: safe.left + w / 2, y: mid }),
        maxLines: 2,
      },
      right: {
        name: "on the right",
        area: { ...safe, left: safeCx },
        align: "center",
        want: (w) => ({ x: safe.right - w / 2, y: mid }),
        maxLines: 2,
      },
      line: {
        name: "on the accent line",
        area: safe,
        align: "center",
        want: (w, h) => ({ x: safeCx, y: preset.accent.noHeadY + h / 2 }),
        maxLines: 2,
      },
      anywhere: {
        name: "in the free part of the safe zone",
        area: safe,
        align: "center",
        want: (w, h) => ({ x: safeCx, y: face ? face.top - h : mid }),
        maxLines: 2,
      },
    };
    if (face) {
      areas.beside_head = {
        name: "beside the head",
        area: {
          ...safe,
          top: Math.max(safe.top, face.top),
          bottom: Math.min(safe.bottom, face.bottom),
        },
        align: "center",
        want: (w, h) => ({ x: face.left - w / 2, y: face.top + h / 2 }),
        maxLines: 2,
      };
    }
    const base = face ? ["above", "top", "anywhere"] : ["line", "anywhere"];
    const wished = extra.wish && areas[extra.wish] ? [extra.wish] : [];
    const names = [...new Set([...wished, ...base])];
    const candidates = names.map((name) => areas[name]!);
    const obstacles = [...faceObstacles(span), ...bodies, ...textDuring(span), notch];
    const words = text.split(" ");
    const sizes = sizesFrom(fullSize, preset).filter(
      (size) => extra.wish !== "small" || size <= Math.round(fullSize * 0.8),
    );
    for (const candidate of candidates) {
      for (const size of sizes) {
        for (const lineCount of words.length > 1 ? [1, 2] : [1]) {
          const lines = lineCount === 1 ? [text] : balancedBreak(words, font, size);
          const widths = lines.map((line) => measurer.width(font, size, line));
          const width = Math.max(...widths);
          const height = lines.length * size;
          const spot = placeBox(
            candidate.area,
            obstacles,
            width,
            height,
            candidate.want(width, height),
          );
          if (!spot) continue;
          const item: OverlayItem = {
            id: extra.id,
            kind: "accent",
            start: { word: accent.from },
            end: { word: accent.to, edge: "end" },
            words: ids,
            position: { x: spot.x, y: spot.y, align: "left" },
            size,
            ...(lines.length > 1 ? { break_after: lines[0]!.split(" ").length } : {}),
          };
          overlays.set(extra.id, item);
          shown.push({
            id: extra.id,
            start: span.start,
            end: span.end,
            box: { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + height },
          });
          const label = `${accent.title ? "the title" : "accent"} ${quote(text)}`;
          if (candidate !== candidates[0]) {
            record.push({
              item: extra.id,
              action: "moved",
              rule: "accent-spot",
              reason: `${label} sits ${candidate.name}: no room ${candidates[0]!.name}`,
            });
          }
          if (wished.length > 0 && candidate !== candidates[0]) {
            record.push({
              item: extra.id,
              action: "wish-not-kept",
              rule: "wish",
              reason: `${label} could not go ${candidates[0]!.name} as asked`,
            });
          }
          if (size < fullSize) {
            record.push({
              item: extra.id,
              action: "shrunk",
              rule: "accent-size",
              reason: `${label} set at ${size} px instead of ${fullSize} px to fit`,
            });
          }
          if (lines.length > 1) {
            record.push({
              item: extra.id,
              action: "wrapped",
              rule: "accent-wrap",
              reason: `${label} set in two lines to fit the frame`,
            });
          }
          return true;
        }
      }
    }
    record.push({
      item: extra.id,
      action: "dropped",
      rule: "no-room",
      reason: `${accent.title ? "the title" : "accent"} ${quote(text)} found no free place from ${at(span.start)} to ${at(span.end)}, even at ${sizes.at(-1)} px in two lines`,
    });
    return false;
  }

  function balancedBreak(words: readonly string[], font: FontKey, size: number): string[] {
    let best: string[] = [words.join(" ")];
    let widest = Infinity;
    for (let cut = 1; cut < words.length; cut += 1) {
      const lines = [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
      const width = Math.max(...lines.map((line) => measurer.width(font, size, line)));
      if (width < widest - SLACK) {
        widest = width;
        best = lines;
      }
    }
    return best;
  }

  function placeBigWord(extra: Extra, span: { start: number; end: number }): boolean {
    const first = word(input.big_word!.word);
    const text = cleanWord(first.text, preset);
    const spec = preset.behind.word;
    const { width: frameWidth, height: frameHeight } = preset.frame;
    const perPx = measurer.width(spec.font, 1, text);
    const fit = perPx > 0 ? Math.floor((frameWidth - 2 * spec.margin) / perPx) : spec.maxSize;
    const largest = Math.max(8, Math.min(spec.maxSize, fit));
    const sizes = sizesFrom(largest, preset).filter(
      (size) => size >= 8 && (extra.wish !== "small" || size <= Math.round(largest * 0.8)),
    );
    const face = facesOver(headTrack, span.start, span.start)[0] ?? null;
    const centre = face ? face.top + spec.belowHeadTop : spec.noHeadY;
    const area = {
      left: spec.margin,
      right: frameWidth - spec.margin,
      top: spec.margin,
      bottom: frameHeight - spec.margin,
    };
    const obstacles = textDuring(span);
    for (const size of sizes) {
      const width = perPx * size;
      const spot = placeBox(area, obstacles, width, size, { x: frameWidth / 2, y: centre });
      if (!spot) continue;
      behind.set(extra.id, {
        id: extra.id,
        kind: "word",
        text,
        start: { word: first.id },
        end: anchorAt(
          span.end,
          transcript.words.filter((w) => w.start >= first.start),
        ),
        position: spot,
        size,
      });
      shown.push({
        id: extra.id,
        start: span.start,
        end: span.end,
        box: { left: spot.x, right: spot.x + width, top: spot.y, bottom: spot.y + size },
      });
      if (size < largest) {
        record.push({
          item: extra.id,
          action: "shrunk",
          rule: "big-word-size",
          reason: `the big word ${quote(text)} set at ${size} px instead of ${largest} px, clear of the captions`,
        });
      }
      return true;
    }
    record.push({
      item: extra.id,
      action: "dropped",
      rule: "no-room",
      reason: `the big word ${quote(text)} found no place clear of the captions from ${at(span.start)} to ${at(span.end)}`,
    });
    return false;
  }

  function placePhoto(extra: Extra, span: { start: number; end: number }): boolean {
    const index = Number(/\d+/.exec(extra.ref)![0]);
    const photo = input.photos[index]!;
    const kept = (current.tracks.behind ?? []).find(
      (item) => item.kind === "photo" && item.photo_id === photo.photo_id,
    );
    const wished = BEHIND_SPOTS.find((spot) => spot === photo.wish);
    const order: BehindSpot[] = [
      ...new Set([
        ...(wished ? [wished] : []),
        ...(kept?.kind === "photo" ? [kept.spot] : []),
        ...BEHIND_SPOTS,
      ]),
    ];
    const text = shown.filter((item) => during(item, span));
    const free = order.find(
      (spot) =>
        spotClearOfFace(spot, span, preset, headTrack) &&
        !text.some((item) => overlaps(item.box, spotBox(spot, preset))),
    );
    const label = `photo ${index + 1}`;
    if (!free) {
      record.push({
        item: extra.id,
        action: "dropped",
        rule: "no-room",
        reason: `${label}: every photo spot is under captions or the face from ${at(span.start)} to ${at(span.end)}`,
      });
      return false;
    }
    const sentence = sentenceOf(photo.from)!;
    behind.set(extra.id, {
      id: extra.id,
      kind: "photo",
      photo_id: photo.photo_id,
      spot: free,
      start:
        Math.abs(span.start - sentence.start) < 0.0005
          ? { word: sentence.from }
          : Math.abs(span.start - word(photo.from).start) < 0.0005
            ? { word: photo.from }
            : anchorAt(span.start, transcript.words),
      end: anchorAt(span.end, transcript.words),
    });
    if (free !== order[0]) {
      record.push({
        item: extra.id,
        action: wished ? "wish-not-kept" : "moved",
        rule: wished ? "wish" : "photo-spot",
        reason: `${label} sits in the ${free} spot: the ${order[0]} spot is under captions or the face`,
      });
    }
    return true;
  }

  // An extra's end held clear of every accepted extra: an earlier one may be
  // cut short for it down to its own minimum; it may itself end before a later
  // one, down to its minimum; else it waits for nothing and is dropped.
  function fitTime(
    extra: Extra,
    taken: readonly Accepted[],
  ):
    | { ok: true; end: number; trims: { accepted: Accepted; end: number }[]; before?: Accepted }
    | { ok: false; with: Accepted } {
    let end = extra.end;
    let before: Accepted | undefined;
    const trims: { accepted: Accepted; end: number }[] = [];
    for (const other of [...taken].sort((a, b) => a.start - b.start)) {
      if (!during({ start: extra.start, end }, other)) continue;
      if (other.start < extra.start - SLACK) {
        if (extra.start - other.start < other.extra.min - SLACK) return { ok: false, with: other };
        trims.push({ accepted: other, end: extra.start });
      } else {
        if (other.start - extra.start < extra.min - SLACK) return { ok: false, with: other };
        end = other.start;
        before = other;
      }
    }
    return { ok: true, end, trims, ...(before ? { before } : {}) };
  }

  // The tracks, in the current version's caption order and the answer's order.
  const outCaptions: CaptionItem[] = captions.map((caption, index) => {
    const lastWord = unitEndWord.get(index)!;
    const end = unitEnd.get(index)!;
    const offset = ms(end - lastWord.end);
    const place = placedCaptions.get(index)!;
    return {
      ...caption,
      end:
        offset === 0
          ? { word: lastWord.id, edge: "end" }
          : { word: lastWord.id, edge: "end", offset },
      position: { x: place.x, y: place.y, align: "left" },
      size: place.size,
    };
  });
  const outOverlays: OverlayItem[] = [];
  for (const id of accentIds) {
    const item = overlays.get(id);
    if (!item) continue;
    const span = accepted.find((entry) => entry.extra.id === id)!;
    const from = byId.get((item.start as { word: string }).word)!;
    outOverlays.push({
      ...item,
      end: anchorAt(
        span.end,
        transcript.words.filter((w) => w.start >= from.start),
      ),
    });
  }
  const outBehind: BehindItem[] = [];
  for (const extra of extras) {
    if (extra.kind === "accent") continue;
    const item = behind.get(extra.id);
    if (!item) continue;
    const span = accepted.find((entry) => entry.extra.id === extra.id)!;
    const start = resolveAnchor(item.start, byId, duration);
    outBehind.push({
      ...item,
      end: anchorAt(
        span.end,
        transcript.words.filter((w) => w.start >= start),
      ),
    });
  }
  // Photos before the big word, as the answer lists them.
  outBehind.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "photo" ? -1 : 1));

  return {
    tracks: {
      footage: current.tracks.footage,
      captions: outCaptions,
      overlays: outOverlays,
      transitions,
      sounds: current.tracks.sounds,
      ...(outBehind.length > 0 ? { behind: outBehind } : {}),
    },
    record,
  };
}

// Whether the face leaves a photo spot clear (within the preset's share) at
// every moment of a span: the same faces the `behind-face` check reads.
function spotClearOfFace(
  spot: BehindSpot,
  span: { start: number; end: number },
  preset: Preset,
  headTrack: HeadTrack,
): boolean {
  return facesOver(headTrack, span.start, span.end).every(
    (face) => spotFaceShare(spot, face, preset) <= preset.behind.maxFaceShare + SLACK,
  );
}
