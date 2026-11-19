import { describe, expect, it } from "vitest";
import { revealShownAt, wordReveal } from "./reveal.ts";

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
