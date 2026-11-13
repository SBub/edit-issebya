import { describe, expect, it } from "vitest";
import { ownerItemJson, transcriptOf } from "../../test-support/eval-fixtures.ts";
import { parseOwnerItem, spanOfMark } from "./owner-marks.ts";

const TEXT = "we work to live and we live to work every day";
const WORDS = transcriptOf(TEXT).words;

describe("spanOfMark", () => {
  it("finds a mark by its words", () => {
    expect(spanOfMark(WORDS, { start: 2, end: 3.5, words: "to live" })).toEqual({ from: 2, to: 3 });
  });

  it("takes the run starting nearest the mark's start when the words come back", () => {
    expect(spanOfMark(WORDS, { start: 0, end: 0.5, words: "we" })).toEqual({ from: 0, to: 0 });
    expect(spanOfMark(WORDS, { start: 5, end: 5.5, words: "we" })).toEqual({ from: 5, to: 5 });
  });

  it("falls back to the mark's seconds when its words are not in the transcript", () => {
    expect(spanOfMark(WORDS, { start: 6, end: 8.5, words: "live 2 work" })).toEqual({
      from: 6,
      to: 8,
    });
    expect(spanOfMark(WORDS, { start: 9, end: 10.5 })).toEqual({ from: 9, to: 10 });
  });

  it("finds nothing for a mark outside the transcript", () => {
    expect(spanOfMark(WORDS, { start: 40, end: 41, words: "gone" })).toBeNull();
  });
});

describe("parseOwnerItem", () => {
  it("reads the scored components into word spans and leaves the visuals and the hook out", () => {
    const item = parseOwnerItem(
      ownerItemJson(TEXT, {
        accent: [{ start: 1, end: 3.5, words: "work to live" }],
        bigword: [{ start: 10, end: 10.5, words: "day" }],
        question: [{ start: 5, end: 8.5, words: "we live to work" }],
        nothing: [{ start: 9, end: 10.5, words: "every day" }],
        list: [
          {
            level: "phrases",
            start: 1,
            end: 8.5,
            items: [
              { start: 1, end: 1.5, words: "work" },
              { start: 8, end: 8.5, words: "work" },
            ],
          },
        ],
      }),
    );
    expect(item).toMatchObject({
      id: "item-a",
      versionId: "item-a-version",
      caseKey: "owner-reels-aaaaaaaa",
      reelId: "aaaaaaaa",
      nothing: [{ from: 9, to: 10 }],
    });
    expect(item.words).toHaveLength(11);
    expect(item.marks).toEqual([
      { component: "accent", span: { from: 1, to: 3 } },
      { component: "bigword", span: { from: 10, to: 10 } },
      { component: "question", span: { from: 5, to: 8 } },
      {
        component: "list",
        span: { from: 1, to: 8 },
        items: [
          { from: 1, to: 1 },
          { from: 8, to: 8 },
        ],
        level: "phrases",
      },
    ]);
  });

  it("refuses a mark that covers no word, naming the item and the mark", () => {
    expect(() =>
      parseOwnerItem(ownerItemJson(TEXT, { accent: [{ start: 90, end: 91, words: "gone" }] })),
    ).toThrow(/item-a: the accent mark "gone" at 90s covers no word/);
  });

  it("refuses an item that is not a labelled reel", () => {
    expect(() => parseOwnerItem({ id: "x", input: {} })).toThrow(
      /dataset item x is not an owner-labelled reel/,
    );
  });
});
