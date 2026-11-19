// The pure parts of transcribe's re-listen (transcribe.ts runs them). Whisper
// `small` sometimes drops words. Where the audio and the aligned times say a
// word may be missing (a spot), a larger Whisper model hears a short window
// around it again, and its words replace the old ones only between two words
// both models agree on. A window that brings nothing new changes nothing.
import { spokenLetters } from "./align.ts";
import { missedSpeech } from "./speech-gaps.ts";
import type { Word } from "./transcript.ts";
import { RELISTEN_MODEL } from "./whisper-model.ts";

// Every re-listen setting; part of transcribe's fingerprint.
export const RELISTEN_SETTINGS = {
  // The model that hears a window again, through HyperFrames like `small`.
  model: "medium",
  modelSha256: RELISTEN_MODEL.sha256,
  // A gap spot: sound in a gap of the transcript no more than
  // gapBelowSpeechDb under the clip's speech level, for at least gapSeconds
  // without a break (the envelope's frames are envelopeFrameSeconds long).
  gapSeconds: 0.45,
  gapBelowSpeechDb: 10,
  envelopeFrameSeconds: 0.01,
  // A stretched word: at least stretchRatio times the clip's median seconds
  // per letter, and at least stretchExtraSeconds longer than that median
  // would make it.
  stretchRatio: 3,
  stretchExtraSeconds: 0.4,
  // Candidates closer than this are one spot.
  joinSeconds: 1,
  // The window: the spot, this many old words on each side, and up to
  // windowPadSeconds of the pause beyond them (never more than half of it).
  windowWords: 3,
  windowPadSeconds: 0.3,
} as const;

export type RelistenSettings = typeof RELISTEN_SETTINGS;

const EPSILON = 1e-6;

// A place where a word may be missing: [start, end] in seconds, and what
// pointed at it.
export interface Spot {
  start: number;
  end: number;
  kinds: ("gap" | "word")[];
}

// The stretched words: a word the aligner had to spread over far more audio
// than its letters need, which is what happens to the neighbour of a dropped
// word. Letters are the aligner's, of the word's spoken form (spokenLetters:
// "2027." counts the letters of "twenty twenty seven"), so a long number can
// be a spot too; a word without any is skipped.
export function stretchedWords(
  words: readonly Word[],
  settings: RelistenSettings,
  language: string,
): Word[] {
  const counts = spokenLetters(
    words.map((word) => word.text),
    language,
  );
  const lettered = words
    .map((word, index) => ({ word, letters: counts[index]! }))
    .filter(({ letters }) => letters > 0);
  if (lettered.length === 0) return [];
  const perLetter = lettered
    .map(({ word, letters }) => (word.end - word.start) / letters)
    .sort((a, b) => a - b);
  const median = perLetter[Math.floor(perLetter.length / 2)]!;
  return lettered
    .filter(({ word, letters }) => {
      const seconds = word.end - word.start;
      return (
        seconds / letters >= settings.stretchRatio * median - EPSILON &&
        seconds - letters * median >= settings.stretchExtraSeconds - EPSILON
      );
    })
    .map(({ word }) => word);
}

// The spots of a clip, in order: every gap of the transcript with sustained
// speech-level sound (retime's `missedSpeech`, with re-listen's own length),
// every stretched word, neighbours closer than joinSeconds joined into one.
export function relistenSpots({
  words,
  envelope,
  settings,
  language,
}: {
  words: readonly Word[];
  envelope: readonly number[];
  settings: RelistenSettings;
  language: string;
}): Spot[] {
  const gaps = missedSpeech({
    words,
    envelope,
    durationSeconds: envelope.length * settings.envelopeFrameSeconds,
    settings: {
      envelopeFrameSeconds: settings.envelopeFrameSeconds,
      missedSpeechBelowSpeechDb: settings.gapBelowSpeechDb,
      missedSpeechSeconds: settings.gapSeconds,
    },
  });
  const candidates: Spot[] = [
    ...gaps.map(([start, end]): Spot => ({ start, end, kinds: ["gap"] })),
    ...stretchedWords(words, settings, language).map((word): Spot => ({
      start: word.start,
      end: word.end,
      kinds: ["word"],
    })),
  ].sort((a, b) => a.start - b.start);
  const spots: Spot[] = [];
  for (const candidate of candidates) {
    const last = spots.at(-1);
    if (last && candidate.start - last.end <= settings.joinSeconds + EPSILON) {
      last.end = Math.max(last.end, candidate.end);
      last.kinds.push(...candidate.kinds);
    } else {
      spots.push(candidate);
    }
  }
  return spots;
}

// What is heard again for a spot: the old words `first` to `last` (indices,
// both included) and the audio [from, to].
export interface Window {
  first: number;
  last: number;
  from: number;
  to: number;
}

// The window of a spot: the old words that touch it, windowWords more on each
// side, and the audio from the first to the last of them (or the spot's own
// edge when it reaches further), with up to windowPadSeconds of the pause
// before and after, never more than half of that pause, never past the clip.
export function relistenWindow(
  spot: Spot,
  words: readonly Word[],
  clipSeconds: number,
  settings: RelistenSettings,
): Window {
  // The first word ending after the spot starts, the last starting before it ends.
  let inside = words.findIndex((word) => word.end > spot.start - EPSILON);
  if (inside < 0) inside = words.length;
  let outside = -1;
  words.forEach((word, index) => {
    if (word.start < spot.end + EPSILON) outside = index;
  });
  const first = Math.max(0, Math.min(inside, outside + 1) - settings.windowWords);
  const last = Math.min(words.length - 1, Math.max(outside, inside - 1) + settings.windowWords);
  const start = Math.min(spot.start, words[first]!.start);
  const end = Math.max(spot.end, words[last]!.end);
  const pauseBefore = start - (first > 0 ? words[first - 1]!.end : 0);
  const pauseAfter = (last < words.length - 1 ? words[last + 1]!.start : clipSeconds) - end;
  const pad = (pause: number) => Math.min(settings.windowPadSeconds, Math.max(0, pause) / 2);
  return {
    first,
    last,
    from: Math.max(0, start - pad(pauseBefore)),
    to: Math.min(clipSeconds, end + pad(pauseAfter)),
  };
}

// ffmpeg's arguments: the window's audio as a 16 kHz mono WAV, the format
// whisper reads (HyperFrames passes such a file on unchanged).
export function windowArgs(input: string, window: Window, output: string): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-ss",
    window.from.toFixed(3),
    "-to",
    window.to.toFixed(3),
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    output,
  ];
}

// The texts of HyperFrames' word list for a window, trimmed, empty ones
// dropped. A window in which nothing was heard gives none.
export function heardTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error("transcribe: HyperFrames result is not a word list");
  return raw
    .map((item) => (item as { text?: unknown } | null)?.text)
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.trim())
    .filter((text) => text !== "");
}

// A word as both models are compared: lower case, accents and punctuation gone.
function letters(text: string): string {
  return text
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9']/g, "");
}

// The longest run of pairs [old index, heard index] of the same word, in
// order (a longest common subsequence). A word with no letter or digit never pairs.
function pairsOf(old: readonly string[], heard: readonly string[]): [number, number][] {
  const table = Array.from({ length: old.length + 1 }, () =>
    new Array<number>(heard.length + 1).fill(0),
  );
  const same = (a: number, b: number) => old[a] !== "" && old[a] === heard[b];
  for (let a = old.length - 1; a >= 0; a -= 1) {
    for (let b = heard.length - 1; b >= 0; b -= 1) {
      table[a]![b] = same(a, b)
        ? table[a + 1]![b + 1]! + 1
        : Math.max(table[a + 1]![b]!, table[a]![b + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let a = 0;
  let b = 0;
  while (a < old.length && b < heard.length) {
    if (same(a, b)) {
      pairs.push([a, b]);
      a += 1;
      b += 1;
    } else if (table[a + 1]![b]! >= table[a]![b + 1]!) {
      a += 1;
    } else {
      b += 1;
    }
  }
  return pairs;
}

const ENDS_SENTENCE = /[.?!]["')\]]*$/;
const ENDS_PLAIN = /[\p{L}\p{N}]$/u;
const STARTS_CAPITAL = /^["'([]*\p{Lu}/u;

function capitalised(text: string): string {
  return text.replace(/\p{L}/u, (letter) => letter.toUpperCase());
}

// The writing of the new words at the join, three small rules. The window is
// a fragment, so Whisper writes it without the sentences the whole clip had:
//   1. A re-heard word that is one of the old words it replaces (same
//      letters) keeps the old writing, capital and punctuation included.
//   2. An old word that started a sentence (a capital, after a word ending in
//      . ? or !) still starts one: the word now before it gets a full stop
//      when it ends in a letter or a digit.
//   3. A new word right after a word ending in . ? or ! gets a capital.
// `before` is the old word in front of the replaced ones; `old` the replaced
// words and the old word after them (the closing anchor, last); `heard` the
// new words; `kept[i]` the index in `old` of the word heard[i] is, or null.
function joinWriting(
  before: string,
  old: readonly string[],
  heard: readonly string[],
  kept: readonly (number | null)[],
): string[] {
  const startedSentence = (index: number) =>
    STARTS_CAPITAL.test(old[index]!) && ENDS_SENTENCE.test(index > 0 ? old[index - 1]! : before);
  // The new words, then the closing anchor (always kept as it was).
  const texts = [
    ...heard.map((text, i) => (kept[i] === null ? text : old[kept[i]!]!)),
    old.at(-1)!,
  ];
  const from = [...kept, old.length - 1];
  for (let i = 0; i < texts.length; i += 1) {
    const previous = i > 0 ? texts[i - 1]! : before;
    const source = from[i]!;
    if (source !== null && i > 0 && startedSentence(source) && ENDS_PLAIN.test(previous)) {
      texts[i - 1] = `${previous}.`;
    }
    if (source === null && ENDS_SENTENCE.test(i > 0 ? texts[i - 1]! : before)) {
      texts[i] = capitalised(texts[i]!);
    }
  }
  return texts.slice(0, -1);
}

// The old words `from` to `to` (indices, `to` excluded) replaced by `texts`.
export interface Replacement {
  from: number;
  to: number;
  texts: string[];
}

// What a window's re-heard words change (pure): null when nothing. The old
// words of the window and the heard ones are matched in order; the nearest
// matched old word ending before the spot and the nearest one starting after
// it are the anchors, and only the words between the two can change. No
// anchor on one side (the models disagree around the spot, or the spot is at
// the clip's edge) keeps the old words, and so do the same words heard again.
// Between the anchors, the heard words are taken, with one exception: where
// they would only swap old words that lie wholly outside the spot for other
// words (the larger model mishearing a word the spot never put in doubt), the
// old words stay.
export function mergeHeard({
  words,
  window,
  spot,
  heard,
}: {
  words: readonly Word[];
  window: Window;
  spot: Spot;
  heard: readonly string[];
}): Replacement | null {
  const old = words.slice(window.first, window.last + 1);
  const oldLetters = old.map((word) => letters(word.text));
  const pairs = pairsOf(oldLetters, heard.map(letters));
  const outside = (word: Word) =>
    word.end <= spot.start + EPSILON || word.start >= spot.end - EPSILON;
  const opening = pairs.findLastIndex(([a]) => old[a]!.end <= spot.start + EPSILON);
  const closing = pairs.findIndex(([a]) => old[a]!.start >= spot.end - EPSILON);
  if (opening < 0 || closing < 0) return null;
  const oldFrom = pairs[opening]![0] + 1;
  const oldTo = pairs[closing]![0];
  // The new words between the anchors, and for each the old word it is
  // (its index from oldFrom), if any.
  const texts: string[] = [];
  const kept: (number | null)[] = [];
  const keep = (index: number) => {
    texts.push(old[index]!.text);
    kept.push(index - oldFrom);
  };
  for (let k = opening; k < closing; k += 1) {
    const [a, b] = pairs[k]!;
    const [nextA, nextB] = pairs[k + 1]!;
    if (k > opening) keep(a);
    const between = old.slice(a + 1, nextA);
    if (between.length > 0 && between.every(outside)) {
      for (let index = a + 1; index < nextA; index += 1) keep(index);
    } else {
      for (const text of heard.slice(b + 1, nextB)) {
        texts.push(text);
        kept.push(null);
      }
    }
  }
  if (texts.map(letters).join(" ") === oldLetters.slice(oldFrom, oldTo).join(" ")) return null;
  return {
    from: window.first + oldFrom,
    to: window.first + oldTo,
    texts: joinWriting(
      old[oldFrom - 1]!.text,
      old.slice(oldFrom, oldTo + 1).map((word) => word.text),
      texts,
      kept,
    ),
  };
}

function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// The transcript with the replacements made (pure), in order; a replacement
// that overlaps one already made is dropped (its old words stay). The new
// words share the time between the words around them evenly: placeholders,
// the aligner times every word afterwards. Ids are not given here.
export function applyReplacements(
  words: readonly Word[],
  replacements: readonly Replacement[],
): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let next = 0;
  for (const replacement of [...replacements].sort((a, b) => a.from - b.from)) {
    if (replacement.from < next) continue;
    for (const word of words.slice(next, replacement.from)) out.push({ ...word });
    const from = out.at(-1)?.end ?? 0;
    const to = Math.max(from, words[replacement.to]?.start ?? words.at(-1)!.end);
    const each = (to - from) / Math.max(1, replacement.texts.length);
    replacement.texts.forEach((text, i) => {
      out.push({ text, start: ms(from + i * each), end: ms(from + (i + 1) * each) });
    });
    next = replacement.to;
  }
  for (const word of words.slice(next)) out.push({ ...word });
  return out.map(({ text, start, end }) => ({ text, start, end }));
}

// The step line's re-listen part: nothing without a spot, else how many spots
// were heard again and what that did to the word count ("1 spot re-listened,
// 6 words added").
export function relistenSummary(spots: number, before: number, after: number, changed: boolean) {
  if (spots === 0) return "";
  const heard = `${spots} ${spots === 1 ? "spot" : "spots"} re-listened`;
  if (!changed) return `, ${heard}, no change`;
  const count = Math.abs(after - before);
  const words = `${count} ${count === 1 ? "word" : "words"}`;
  if (after > before) return `, ${heard}, ${words} added`;
  if (after < before) return `, ${heard}, ${words} removed`;
  return `, ${heard}, words changed`;
}
