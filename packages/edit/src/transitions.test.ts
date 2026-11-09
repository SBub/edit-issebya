import { describe, expect, it } from "vitest";
import { ISSEBYA_PRESET, SHOWN_FLOOR_SECONDS } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { hiddenCaptionIds, levelStyle, transitionTiming } from "./transitions.ts";
import type { Word } from "./transcript.ts";

const P = ISSEBYA_PRESET;
const NUMBERED = P.transitions.numbered;

// Words `a` to `e`: `c` ends at 3.0, then `pause` seconds of silence.
function wordsWith(pause: number): Word[] {
  return [
    { id: "a", text: "one", start: 1, end: 1.4 },
    { id: "b", text: "two", start: 1.5, end: 2.2 },
    { id: "c", text: "three", start: 2.3, end: 3 },
    { id: "d", text: "four", start: 3 + pause, end: 3.4 + pause },
    { id: "e", text: "five", start: 3.5 + pause, end: 4 + pause },
  ];
}

describe("transitionTiming", () => {
  it("shows exactly while its phrase is spoken: in as its first word starts, gone at its last word's end", () => {
    const words = wordsWith(0.2);
    const timing = transitionTiming({ from: "a", to: "c" }, words, 10, P, NUMBERED)!;
    expect(timing.seconds).toBe(NUMBERED.seconds);
    expect(timing.start).toBe(1);
    expect(timing.end).toBe(3);
    expect(timing.startAnchor).toEqual({ word: "a" });
    expect(timing.endAnchor).toEqual({ word: "c", edge: "end" });
    expect(timing.lengthened).toBe(false);
  });

  it("does not hold after its last word: it leaves there, even before a long pause", () => {
    const words = wordsWith(3);
    expect(P.transition).not.toHaveProperty("holdSeconds");
    expect(transitionTiming({ from: "a", to: "c" }, words, 10, P, NUMBERED)!.end).toBe(3);
  });

  it("has no minimum: a short phrase keeps exactly its words", () => {
    // "x" is said for 0.05 s: under the shown floor, and kept as it is said.
    const words: Word[] = [
      { id: "x", text: "one", start: 1, end: 1.05 },
      { id: "y", text: "two", start: 1.1, end: 1.2 },
    ];
    const timing = transitionTiming({ from: "x", to: "x" }, words, 10, P, NUMBERED)!;
    expect([timing.start, timing.end]).toEqual([1, 1.05]);
    expect(timing.lengthened).toBe(false);
  });

  it("lengthens only a phrase with no length at all, to the shown floor from its start", () => {
    const words: Word[] = [{ id: "x", text: "one", start: 1, end: 1 }];
    const timing = transitionTiming({ from: "x", to: "x" }, words, 10, P, NUMBERED)!;
    expect([timing.start, timing.end]).toEqual([1, 1 + SHOWN_FLOOR_SECONDS]);
    expect(timing.lengthened).toBe(true);
  });

  it("starts at the reel's start when its phrase opens the reel", () => {
    const words = wordsWith(0.2).map((word) => ({ ...word, start: word.start - 1 }));
    const timing = transitionTiming({ from: "a", to: "c" }, words, 10, P, NUMBERED)!;
    expect(timing.start).toBe(0);
    expect(timing.startAnchor).toEqual({ reel: "start" });
  });

  it("leaves at the reel's end after the last phrase", () => {
    const timing = transitionTiming({ from: "e", to: "e" }, wordsWith(0.2), 4.2, P, NUMBERED)!;
    expect(timing.end).toBe(4.2);
    expect(timing.endAnchor).toEqual({ reel: "end" });
  });

  it("is too short on a reel under the shown floor, when its phrase has no length", () => {
    const words: Word[] = [{ id: "a", text: "hi", start: 0.4, end: 0.4 }];
    expect(transitionTiming({ from: "a", to: "a" }, words, 0.4, P, NUMBERED)).toBeNull();
  });
});

describe("transition style roles", () => {
  it("sets the lead-in in caption text, the key phrase and the number in accent text", () => {
    expect(levelStyle("lead", P)).toEqual({
      font: P.caption.font,
      size: P.fonts[P.caption.font].size,
      color: P.caption.color,
    });
    expect(levelStyle("key", P)).toEqual({
      font: P.accent.font,
      size: P.fonts[P.accent.font].size,
      color: P.accent.color,
    });
    expect(levelStyle("number", P)).toEqual({
      font: P.accent.font,
      size: P.transitions.numbered.numberSize,
      color: P.accent.color,
    });
  });
});

describe("hiddenCaptionIds", () => {
  it("lists the captions a transition shows as its levels, none for a version saved before", () => {
    const transitions = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;
    const hidden = hiddenCaptionIds(transitions.edit);
    expect(hidden.has("cw100")).toBe(true);
    expect(hidden.has("cw104")).toBe(false);
    const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
    expect(hiddenCaptionIds(hand.edit).size).toBe(0);
  });
});
