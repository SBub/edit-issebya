import { describe, expect, it } from "vitest";
import { isQuestion, questionReveal, questionShownAt, questionText } from "./question.ts";

// "pick one idea and bring it": six spoken words, a pause after the third.
const SPOKEN = [
  { start: 2.0 },
  { start: 2.3 },
  { start: 2.55 },
  { start: 3.4 },
  { start: 3.65 },
  { start: 3.9 },
];
const SPAN = { start: 2.0, end: 4.2 };
const TEXT = questionText("pick one idea and bring it");

describe("the question mark", () => {
  it("is added once at the end of a text that has none", () => {
    expect(questionText("pick one idea")).toBe("pick one idea?");
  });

  it("is never doubled on a text that already ends with one", () => {
    expect(questionText("pick one idea?")).toBe("pick one idea?");
    expect(questionText("pick one idea? ")).toBe("pick one idea?");
  });

  it("is part of the last word, so it appears with it", () => {
    const reveal = questionReveal(TEXT, SPOKEN, SPAN);
    expect(reveal.at(-1)).toEqual({ text: "it?", at: 3.9 });
    expect(reveal.filter((word) => word.text.includes("?"))).toHaveLength(1);
    expect(questionShownAt(reveal, 3.89)).not.toContain("?");
    expect(questionShownAt(reveal, 3.9)).toBe("pick one idea and bring it?");
  });
});

describe("the question's reveal", () => {
  it("shows each word from the moment it is spoken", () => {
    expect(questionReveal(TEXT, SPOKEN, SPAN)).toEqual([
      { text: "pick", at: 2.0 },
      { text: "one", at: 2.3 },
      { text: "idea", at: 2.55 },
      { text: "and", at: 3.4 },
      { text: "bring", at: 3.65 },
      { text: "it?", at: 3.9 },
    ]);
  });

  it("builds the question up: the words shown at a given time", () => {
    const reveal = questionReveal(TEXT, SPOKEN, SPAN);
    expect(questionShownAt(reveal, 1.99)).toBe("");
    expect(questionShownAt(reveal, 2.0)).toBe("pick");
    expect(questionShownAt(reveal, 2.29)).toBe("pick");
    expect(questionShownAt(reveal, 2.4)).toBe("pick one");
    // Through the pause nothing new appears and nothing leaves.
    expect(questionShownAt(reveal, 3.0)).toBe("pick one idea");
    expect(questionShownAt(reveal, 3.7)).toBe("pick one idea and bring");
    // Whole from its last word to its end.
    expect(questionShownAt(reveal, 4.2)).toBe("pick one idea and bring it?");
  });

  it("shows the first word as the question starts, even when it starts before its word", () => {
    // A question lengthened to the shown floor starts before its first word.
    const reveal = questionReveal(TEXT, SPOKEN, { start: 1.7, end: 4.2 });
    expect(reveal[0]).toEqual({ text: "pick", at: 1.7 });
    expect(reveal[1]).toEqual({ text: "one", at: 2.3 });
  });

  it("never shows a word after the question's end, nor before the word shown before it", () => {
    const reveal = questionReveal(TEXT, SPOKEN, { start: 2.0, end: 3.5 });
    expect(reveal.map((word) => word.at)).toEqual([2.0, 2.3, 2.55, 3.4, 3.5, 3.5]);
    const unordered = questionReveal("a b c?", [{ start: 1 }, { start: 3 }, { start: 2 }], {
      start: 1,
      end: 4,
    });
    expect(unordered.map((word) => word.at)).toEqual([1, 3, 3]);
  });

  it("spreads a text with another word count over its spoken words in order", () => {
    // A word fix written as one word for two spoken ones.
    expect(
      questionReveal("lock-in?", [{ start: 1 }, { start: 1.4 }], { start: 1, end: 2 }),
    ).toEqual([{ text: "lock-in?", at: 1 }]);
    // Four shown words over two spoken ones.
    expect(
      questionReveal("a b c d?", [{ start: 1 }, { start: 2 }], { start: 1, end: 3 }).map(
        (word) => word.at,
      ),
    ).toEqual([1, 1, 2, 2]);
  });

  it("shows a question with no spoken word whole from its start", () => {
    expect(questionReveal("why now?", [], { start: 5, end: 6 })).toEqual([
      { text: "why", at: 5 },
      { text: "now?", at: 5 },
    ]);
  });
});

describe("which overlay is a question", () => {
  it("is an accent overlay with a question id", () => {
    expect(isQuestion({ id: "question-1", kind: "accent" })).toBe(true);
    expect(isQuestion({ id: "accent-1", kind: "accent" })).toBe(false);
    expect(isQuestion({ id: "question-1", kind: "caption" })).toBe(false);
    expect(isQuestion({ id: "hook", kind: "hook" })).toBe(false);
  });
});
