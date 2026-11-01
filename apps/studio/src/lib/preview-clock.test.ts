import { describe, expect, it } from "vitest";
import { HAVE_FUTURE_DATA, type MediaState, activeAt, canPlayFrom } from "./preview-clock";

const ready = (start = 0, duration = 10): MediaState => ({
  start,
  duration,
  readyState: HAVE_FUTURE_DATA,
  seeking: false,
});

describe("activeAt", () => {
  it("keeps the media whose window holds t, end excluded", () => {
    const a = ready(0, 2);
    const b = ready(2, 3);
    expect(activeAt([a, b], 0)).toEqual([a]);
    expect(activeAt([a, b], 1.999)).toEqual([a]);
    expect(activeAt([a, b], 2)).toEqual([b]);
    expect(activeAt([a, b], 5)).toEqual([]);
  });
});

describe("canPlayFrom", () => {
  it("is true when every active medium has future data", () => {
    expect(canPlayFrom([ready(), ready()], 1)).toBe(true);
    expect(canPlayFrom([ready(), { ...ready(), readyState: 4 }], 1)).toBe(true);
  });

  it("is false when one is only at HAVE_CURRENT_DATA", () => {
    expect(canPlayFrom([ready(), { ...ready(), readyState: 2 }], 1)).toBe(false);
  });

  it("is false while one is seeking", () => {
    expect(canPlayFrom([ready(), { ...ready(), seeking: true }], 1)).toBe(false);
  });

  it("ignores a clip outside its window", () => {
    const later = { ...ready(5, 5), readyState: 0 };
    expect(canPlayFrom([ready(0, 5), later], 4.9)).toBe(true);
    expect(canPlayFrom([ready(0, 5), later], 5)).toBe(false);
  });

  it("is false while a video still sits where it was before the seek", () => {
    expect(canPlayFrom([{ ...ready(), position: 0 }], 4)).toBe(false);
    expect(canPlayFrom([{ ...ready(), position: 3.95 }], 4)).toBe(true);
    expect(canPlayFrom([{ ...ready(2, 5), position: 2 }], 4)).toBe(true);
  });

  it("treats start + duration as outside the window", () => {
    expect(canPlayFrom([{ ...ready(0, 2), readyState: 1 }], 2)).toBe(true);
  });
});
