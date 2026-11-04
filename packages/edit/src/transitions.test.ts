import { describe, expect, it } from "vitest";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import {
  hiddenCaptionIds,
  levelStyle,
  motionSeconds,
  transitionBackground,
  transitionTiming,
} from "./transitions.ts";
import type { Word } from "./transcript.ts";

const P = ISSEBYA_PRESET;
const DIM = P.transitions.dim;

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
  it("finishes its entrance as the first word starts and has left as the next word starts", () => {
    const words = wordsWith(0.2);
    const timing = transitionTiming({ from: "a", to: "c" }, words, 10, P, DIM)!;
    expect(timing.start).toBe(0.7);
    expect(timing.end).toBe(3.2);
    expect(timing.startAnchor).toEqual({ word: "a", offset: -0.3 });
    expect(timing.endAnchor).toEqual({ word: "d" });
    expect(timing.lengthened).toBe(false);
  });

  it("holds at most 1 s after its last word before a long pause, 2 s when asked longer", () => {
    const words = wordsWith(3);
    expect(transitionTiming({ from: "a", to: "c" }, words, 10, P, DIM)!.end).toBe(4);
    expect(transitionTiming({ from: "a", to: "c", wish: "long" }, words, 10, P, DIM)!.end).toBe(5);
  });

  it("moves 1.6 times slower when asked", () => {
    const timing = transitionTiming(
      { from: "a", to: "c", wish: "slow" },
      wordsWith(0.2),
      10,
      P,
      DIM,
    )!;
    expect(timing.seconds).toBe(0.48);
    expect(timing.start).toBe(0.52);
  });

  it("lengthens a short phrase to 1.5 s", () => {
    const timing = transitionTiming({ from: "b", to: "b" }, wordsWith(0.2), 10, P, DIM)!;
    expect(timing.end - timing.start).toBeCloseTo(1.5, 6);
    expect(timing.start).toBe(1.2);
    expect(timing.lengthened).toBe(true);
  });

  it("starts at the reel's start when its phrase opens the reel", () => {
    const words = wordsWith(0.2).map((word) => ({ ...word, start: word.start - 0.9 }));
    const timing = transitionTiming({ from: "a", to: "c" }, words, 10, P, DIM)!;
    expect(timing.start).toBe(0);
    expect(timing.startAnchor).toEqual({ reel: "start" });
  });

  it("leaves at the reel's end after the last phrase, coming in earlier to last 1.5 s", () => {
    const timing = transitionTiming({ from: "e", to: "e" }, wordsWith(0.2), 4.3, P, DIM)!;
    expect(timing.end).toBe(4.3);
    expect(timing.endAnchor).toEqual({ reel: "end" });
    expect(timing.end - timing.start).toBeCloseTo(1.5, 6);
  });

  it("is too short on a reel under 1.5 s", () => {
    const words: Word[] = [{ id: "a", text: "hi", start: 0.1, end: 0.5 }];
    expect(transitionTiming({ from: "a", to: "a" }, words, 1.2, P, DIM)).toBeNull();
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

  it("colours the layer with the background role at the kind's shade", () => {
    expect(transitionBackground(P.transitions.panel, P)).toBe("#121212");
    expect(transitionBackground(DIM, P)).toBe("rgba(18, 18, 18, 0.62)");
    expect(transitionBackground(P.transitions.numbered, P)).toBe("rgba(18, 18, 18, 0.38)");
    expect(transitionBackground(DIM, P, "#336699")).toBe("#336699");
  });

  it("stretches the motion of a slower transition", () => {
    const item = {
      id: "t",
      type: "dim" as const,
      start: { reel: "start" as const },
      end: { reel: "end" as const },
    };
    expect(motionSeconds(item, P)).toBe(0.3);
    expect(motionSeconds({ ...item, pace: "slow" }, P)).toBe(0.48);
  });
});

describe("hiddenCaptionIds", () => {
  it("lists the captions a transition shows as its levels, none for a version saved before", () => {
    const transitions = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;
    const hidden = hiddenCaptionIds(transitions.edit);
    expect(hidden.has("cw26")).toBe(true);
    expect(hidden.has("cw34")).toBe(false);
    const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
    expect(hiddenCaptionIds(hand.edit).size).toBe(0);
  });
});
