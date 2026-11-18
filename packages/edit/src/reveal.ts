import type { Span } from "./timeline.ts";
import { VARIANTS } from "./variants.ts";

// HOW A TEXT BUILDS UP ON SCREEN, unit by unit. Every unit is in its final
// place from the start, hidden, so the lines never reflow; each cuts in at its
// own moment. Two reveals, one mechanism:
// - WORD BY WORD, each word at the moment it is spoken: the entrance of every
//   QUESTION (`question.ts`), of every accent and of every caption.
// - LETTER BY LETTER, typed: the entrance of the written hook (`hook/typed`),
//   the one text nobody says, so its letters are spread evenly over the first
//   part of its time on screen.
// Pure helpers shared by the builder (each unit's element and its moment), the
// sound cues (`sounds.ts`: a key sound in step with the letters) and the specs
// (what is on screen at a time), so the picture, the sound and the tests
// always agree.

// One shown word of a text and the moment it appears.
export interface RevealWord {
  text: string;
  at: number;
}

// One typed letter of a text and the moment it appears: the same shape, a
// shown unit and its moment.
export type RevealLetter = RevealWord;

// Each shown word of a text with the moment it appears: the start of its
// spoken word, never before the text's own start nor after its end, and
// never before the word shown before it. `text` is the text on screen,
// `spoken` its spoken words in order, `span` its time on screen. The first
// word comes in as the text starts (a text that starts after its first word
// was said shows it at once). A text with another word count than its spoken
// words (a word fix that joins or splits words) spreads its words over the
// spoken ones in order.
export function wordReveal(
  text: string,
  spoken: readonly { start: number }[],
  span: { start: number; end: number },
): RevealWord[] {
  const shown = text.split(" ");
  let last = span.start;
  return shown.map((word, index) => {
    const said =
      spoken.length === 0
        ? undefined
        : spoken[
            shown.length === spoken.length
              ? index
              : Math.floor((index * spoken.length) / shown.length)
          ];
    const at = index === 0 || !said ? last : Math.min(Math.max(said.start, last), span.end);
    last = at;
    return { text: word, at };
  });
}

// The text as far as it is built at `time`: the words that have appeared,
// joined as the screen shows them. Empty before the first word.
export function revealShownAt(reveal: readonly RevealWord[], time: number): string {
  return reveal
    .filter((word) => word.at <= time)
    .map((word) => word.text)
    .join(" ");
}

// THE TYPED REVEAL (`hook/typed`): the written hook is typed on screen letter
// by letter, a steady caret after the last typed one (the builder's). The
// letters are spread evenly over the first part of the hook's shown span (the
// entry's `entranceSpan`, 0.6): the first at the hook's start, the last at 60%
// of its time on screen. The whole line then holds until its end.

// What belongs to the character before it: a combining mark (an accent written
// as one, an emoji's variation selector) or a skin tone.
const ATTACHED = /^[\p{M}\p{Emoji_Modifier}]$/u;
const SPACE = /^\s$/u;
// Joins two emoji into one glyph.
const JOINER = "\u200D";

// A text cut into its typed units and the spaces between them, losing
// nothing. One unit is a visible character with what belongs to it (its
// marks, and the parts an emoji is joined from), so nothing that draws as one
// glyph is typed in two steps.
export function typedParts(text: string): { text: string; letter: boolean }[] {
  const parts: { text: string; letter: boolean }[] = [];
  let joining = false;
  for (const char of text) {
    const last = parts.at(-1);
    if (last?.letter && (joining || char === JOINER || ATTACHED.test(char))) {
      last.text += char;
      joining = char === JOINER;
      continue;
    }
    joining = false;
    const letter = !SPACE.test(char);
    if (!letter && last && !last.letter) last.text += char;
    else parts.push({ text: char, letter });
  }
  return parts;
}

// A text's typed units in reading order. Spaces and line breaks are no units:
// they take no time of their own.
export function typedLetters(text: string): string[] {
  return typedParts(text).flatMap((part) => (part.letter ? [part.text] : []));
}

function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// The moment a text typed over `share` of `span` is fully typed.
export function typedUntil(span: Span, share: number): number {
  return ms(span.start + (span.end - span.start) * share);
}

// Each unit of `text` with the moment it appears, to the millisecond: spread
// evenly from the span's start (the first unit) to `share` of the span (the
// last unit). A text of one unit shows it at the start. `span` is the text's
// time on screen after any clamp, so a hook cut to a short reel's end is typed
// over 60% of the time it really has.
export function typedReveal(text: string, span: Span, share: number): RevealLetter[] {
  const letters = typedLetters(text);
  const until = typedUntil(span, share);
  const step = letters.length > 1 ? (until - span.start) / (letters.length - 1) : 0;
  return letters.map((letter, index) => ({
    text: letter,
    at: index === letters.length - 1 && index > 0 ? until : ms(span.start + step * index),
  }));
}

// How many units are on screen at `time`.
export function typedCount(reveal: readonly RevealLetter[], time: number): number {
  return reveal.filter((letter) => letter.at <= time).length;
}

// The hook's reveal: its text typed over its entry's share of its shown span.
export function hookReveal(text: string, span: Span): RevealLetter[] {
  return typedReveal(text, span, VARIANTS["hook/typed"].entranceSpan);
}
