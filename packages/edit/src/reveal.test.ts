import { describe, expect, it } from "vitest";
import { ISSEBYA_PRESET } from "./preset.ts";
import {
  hookReveal,
  revealShownAt,
  typedCount,
  typedLetters,
  typedParts,
  typedReveal,
  typedUntil,
  wordReveal,
} from "./reveal.ts";
import { VARIANTS } from "./variants.ts";

// The reveal of an accent and of a caption: the same helper the question uses
// (`question.test.ts` covers its order, its end and its pause).

describe("an accent's reveal", () => {
  // "hold the line": three spoken words.
  const SPOKEN = [{ start: 4.0 }, { start: 4.3 }, { start: 4.75 }];
  const SPAN = { start: 4.0, end: 5.1 };

  it("shows each word from the moment it is spoken, with no mark added", () => {
    const reveal = wordReveal("hold the line", SPOKEN, SPAN);
    expect(reveal).toEqual([
      { text: "hold", at: 4.0 },
      { text: "the", at: 4.3 },
      { text: "line", at: 4.75 },
    ]);
    expect(revealShownAt(reveal, 3.99)).toBe("");
    expect(revealShownAt(reveal, 4.2)).toBe("hold");
    expect(revealShownAt(reveal, 4.5)).toBe("hold the");
    expect(revealShownAt(reveal, 5.1)).toBe("hold the line");
  });

  it("spreads a shown text shorter than its spoken words over them in order", () => {
    // Its own text of two words over three spoken ones.
    expect(wordReveal("hold on", SPOKEN, SPAN)).toEqual([
      { text: "hold", at: 4.0 },
      { text: "on", at: 4.3 },
    ]);
  });

  it("spreads a shown text longer than its spoken words over them in order", () => {
    // Five shown words over three spoken ones: 0, 0, 1, 1, 2.
    expect(wordReveal("a b c d e", SPOKEN, SPAN).map((word) => word.at)).toEqual([
      4.0, 4.0, 4.3, 4.3, 4.75,
    ]);
  });

  it("shows the words said before the accent's own start as it starts", () => {
    // An accent that starts on its third word's time: nothing waits behind it.
    const reveal = wordReveal("hold the line", SPOKEN, { start: 4.5, end: 5.1 });
    expect(reveal.map((word) => word.at)).toEqual([4.5, 4.5, 4.75]);
    expect(revealShownAt(reveal, 4.5)).toBe("hold the");
  });

  it("shows an accent with its own text and no spoken word whole from its start", () => {
    expect(wordReveal("new here", [], { start: 2, end: 3 }).map((word) => word.at)).toEqual([2, 2]);
  });
});

describe("a caption's reveal", () => {
  it("shows a caption of one word as the caption starts", () => {
    expect(wordReveal("studio", [{ start: 1.2 }], { start: 1.2, end: 1.9 })).toEqual([
      { text: "studio", at: 1.2 },
    ]);
  });

  it("shows a unit of two spoken words word by word", () => {
    // "5 percent": a number with its unit, one caption.
    expect(
      wordReveal("5 percent", [{ start: 3.0 }, { start: 3.4 }], { start: 3.0, end: 4 }),
    ).toEqual([
      { text: "5", at: 3.0 },
      { text: "percent", at: 3.4 },
    ]);
  });

  it("shows a word fix that joins two spoken words in one piece, on the first", () => {
    expect(wordReveal("lock-in", [{ start: 1 }, { start: 1.4 }], { start: 1, end: 2 })).toEqual([
      { text: "lock-in", at: 1 },
    ]);
  });

  it("shows a word fix of two words for one spoken word together", () => {
    // "Gen Z" written for one transcribed word.
    expect(wordReveal("Gen Z", [{ start: 6.2 }], { start: 6.2, end: 7 })).toEqual([
      { text: "Gen", at: 6.2 },
      { text: "Z", at: 6.2 },
    ]);
  });

  it("shows a caption that starts after its word was said at its own start", () => {
    expect(wordReveal("studio", [{ start: 1.2 }], { start: 1.5, end: 1.9 })).toEqual([
      { text: "studio", at: 1.5 },
    ]);
  });
});

// The typed reveal: the hook's letters.

// The hook's whole window (`pace.hook`): 0.2 s to 3 s.
const { fromSeconds, untilSeconds } = ISSEBYA_PRESET.pace.hook;
const WINDOW = { start: fromSeconds, end: untilSeconds };
const SHARE = VARIANTS["hook/typed"].entranceSpan;

describe("a typed text's letters", () => {
  it("are its visible characters in reading order: spaces and line breaks are no letters", () => {
    expect(typedLetters("Gen Z won't")).toEqual(["G", "e", "n", "Z", "w", "o", "n", "'", "t"]);
    expect(typedLetters("two\nlines")).toHaveLength(8);
    expect(typedLetters("   ")).toEqual([]);
    expect(typedLetters("")).toEqual([]);
  });

  it("keep punctuation and digits as letters of their own", () => {
    expect(typedLetters("Why 3x?!")).toEqual(["W", "h", "y", "3", "x", "?", "!"]);
  });

  it("never type one glyph in two steps: a combining mark, an emoji's parts", () => {
    // "e" with a combining acute accent, a thumbs up with a skin tone, a
    // family joined by zero-width joiners.
    expect(typedLetters("café")).toEqual(["c", "a", "f", "é"]);
    expect(typedLetters("ok \u{1F44D}\u{1F3FD}")).toEqual(["o", "k", "\u{1F44D}\u{1F3FD}"]);
    expect(typedLetters("\u{1F468}‍\u{1F469}‍\u{1F467}")).toHaveLength(1);
  });

  it("cut a text into letters and what lies between them, losing nothing", () => {
    const parts = typedParts("a b c");
    expect(parts).toEqual([
      { text: "a", letter: true },
      { text: " ", letter: false },
      { text: "b", letter: true },
      { text: " ", letter: false },
      { text: "c", letter: true },
    ]);
    expect(parts.map((part) => part.text).join("")).toBe("a b c");
  });
});

describe("the typed reveal", () => {
  it("is fully typed at 60% of the shown span", () => {
    expect(SHARE).toBe(0.6);
    // 0.2 s + 60% of 2.8 s.
    expect(typedUntil(WINDOW, SHARE)).toBe(1.88);
    const reveal = hookReveal("Gen Z won't work like you did", WINDOW);
    expect(reveal).toHaveLength(23);
    expect(reveal[0]).toEqual({ text: "G", at: 0.2 });
    expect(reveal.at(-1)).toEqual({ text: "d", at: 1.88 });
  });

  it("spreads the letters evenly, to the millisecond, each after the one before", () => {
    const reveal = hookReveal("Gen Z won't work like you did", WINDOW);
    const step = (1.88 - 0.2) / 22;
    for (const [index, letter] of reveal.entries()) {
      expect(letter.at).toBeCloseTo(0.2 + step * index, 3);
      expect(Math.round(letter.at * 1000)).toBe(letter.at * 1000);
      if (index > 0) expect(letter.at).toBeGreaterThan(reveal[index - 1]!.at);
    }
  });

  it("types a short hook slowly and a long one fast, both done at the same moment", () => {
    const short = hookReveal("Stop", WINDOW);
    expect(short.map((letter) => letter.at)).toEqual([0.2, 0.76, 1.32, 1.88]);
    // The longest hook the prompt may write: 45 characters.
    const long = hookReveal("Nobody tells you this about your first hires!", WINDOW);
    expect(long).toHaveLength(38);
    expect(long[0]!.at).toBe(0.2);
    expect(long.at(-1)!.at).toBe(1.88);
    expect(long[1]!.at - long[0]!.at).toBeCloseTo(1.68 / 37, 3);
  });

  it("shows a hook of one letter at its start", () => {
    expect(hookReveal("?", WINDOW)).toEqual([{ text: "?", at: 0.2 }]);
    expect(hookReveal("", WINDOW)).toEqual([]);
  });

  it("types over 60% of the time a clamped hook really has", () => {
    // A reel of 2.667 s: the window is cut to the reel's end.
    const clamped = { start: 0.2, end: 2.667 };
    const reveal = hookReveal("A short test for the real studio", clamped);
    expect(reveal[0]!.at).toBe(0.2);
    expect(reveal.at(-1)!.at).toBe(1.68);
    // A reel too short for the window: the hook from 0 to its end, 0.5 s.
    const floor = hookReveal("A short test", { start: 0, end: 0.5 });
    expect(floor[0]!.at).toBe(0);
    expect(floor.at(-1)!.at).toBe(0.3);
    expect(floor.every((letter) => letter.at <= 0.3)).toBe(true);
  });

  it("types across lines in reading order: a line break takes no time", () => {
    const one = hookReveal("Gen Z won't work like you did", WINDOW);
    const two = typedReveal(["Gen Z won't", "work like you did"].join(" "), WINDOW, SHARE);
    expect(two).toEqual(one);
  });

  it("counts the letters on screen at a time: none before the start, all from 60% on", () => {
    const reveal = hookReveal("Gen Z won't work like you did", WINDOW);
    expect(typedCount(reveal, 0.199)).toBe(0);
    expect(typedCount(reveal, 0.2)).toBe(1);
    const mid = typedCount(reveal, 1);
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(23);
    expect(typedCount(reveal, 1.879)).toBe(22);
    expect(typedCount(reveal, 1.88)).toBe(23);
    expect(typedCount(reveal, 3)).toBe(23);
  });

  it("is the same every time", () => {
    expect(hookReveal("Gen Z won't work like you did", WINDOW)).toEqual(
      hookReveal("Gen Z won't work like you did", WINDOW),
    );
  });
});
