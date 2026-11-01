import { describe, expect, it } from "vitest";
import { scheduleFrom } from "./sound-schedule";

const PATH = "assets/sounds/mouse-click-trimmed.wav";
const HITS = [
  { id: "a", at: 1.5, path: PATH, gain: 0.224 },
  { id: "b", at: 4.25, path: PATH, gain: 0.5 },
];

describe("scheduleFrom", () => {
  it("starts every hit at its offset from a start at 0", () => {
    expect(scheduleFrom(HITS, 0, 10)).toEqual([
      { id: "a", path: PATH, gain: 0.224, when: 11.5 },
      { id: "b", path: PATH, gain: 0.5, when: 14.25 },
    ]);
  });

  it("skips a hit already begun when resuming mid-reel", () => {
    const [only] = scheduleFrom(HITS, 2, 3);
    expect(only?.id).toBe("b");
    expect(only?.when).toBeCloseTo(5.25, 9);
    expect(scheduleFrom(HITS, 1.6, 0).map((sound) => sound.id)).toEqual(["b"]);
  });

  it("starts a hit exactly at the resume point at once", () => {
    expect(scheduleFrom(HITS, 1.5, 7)[0]).toEqual({ id: "a", path: PATH, gain: 0.224, when: 7 });
  });

  it("gives nothing past the last hit", () => {
    expect(scheduleFrom(HITS, 5, 0)).toEqual([]);
    expect(scheduleFrom([], 0, 0)).toEqual([]);
  });
});
