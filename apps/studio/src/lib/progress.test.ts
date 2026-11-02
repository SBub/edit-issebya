import { describe, expect, it } from "vitest";
import { formatTimeLeft, historyRates, isProgressStep, timeLeftSeconds } from "./progress";

describe("timeLeftSeconds", () => {
  it("is the median rate times the footage, minus the elapsed time", () => {
    expect(
      timeLeftSeconds({ rates: [8000, 8400, 9000], footageSeconds: 50, elapsedMs: 120_000 }),
    ).toBe(300);
  });

  it("gives no estimate with fewer than three earlier rows", () => {
    expect(timeLeftSeconds({ rates: [8000, 8400], footageSeconds: 50, elapsedMs: 0 })).toBeNull();
    expect(timeLeftSeconds({ rates: undefined, footageSeconds: 50, elapsedMs: 0 })).toBeNull();
  });

  it("gives no estimate without the reel's footage seconds", () => {
    expect(timeLeftSeconds({ rates: [1, 2, 3], footageSeconds: null, elapsedMs: 0 })).toBeNull();
  });

  it("takes the mean of the middle two for an even count", () => {
    expect(
      timeLeftSeconds({ rates: [1000, 3000, 2000, 4000], footageSeconds: 10, elapsedMs: 0 }),
    ).toBe(25);
  });

  it("uses only the newest ten rates", () => {
    const rates = [...Array.from({ length: 10 }, () => 1000), 99_000, 99_000, 99_000];
    expect(timeLeftSeconds({ rates, footageSeconds: 10, elapsedMs: 0 })).toBe(10);
  });

  it("is never negative", () => {
    expect(timeLeftSeconds({ rates: [1, 1, 1], footageSeconds: 1, elapsedMs: 60_000 })).toBe(0);
  });

  it("reads footage seconds given as a string (numeric)", () => {
    expect(timeLeftSeconds({ rates: [1000, 1000, 1000], footageSeconds: "30", elapsedMs: 0 })).toBe(
      30,
    );
  });
});

describe("historyRates", () => {
  it("gives ms per footage second, skipping rows without both values", () => {
    expect(
      historyRates([
        { wall_ms: 400_000, reels: { footage_seconds: "50" } },
        { wall_ms: null, reels: { footage_seconds: 50 } },
        { wall_ms: 1000, reels: { footage_seconds: null } },
        { wall_ms: 1000, reels: null },
        { wall_ms: "9000", reels: { footage_seconds: 3 } },
      ]),
    ).toEqual([8000, 3000]);
  });
});

describe("formatTimeLeft", () => {
  it("says no estimate, under a minute, or minutes", () => {
    expect(formatTimeLeft(null)).toBe("no estimate yet");
    expect(formatTimeLeft(0)).toBe("less than a minute left");
    expect(formatTimeLeft(59)).toBe("less than a minute left");
    expect(formatTimeLeft(300)).toBe("about 5 min left");
  });
});

describe("isProgressStep", () => {
  it("is true for the two long steps only", () => {
    expect(isProgressStep("remove_background")).toBe(true);
    expect(isProgressStep("render")).toBe(true);
    expect(isProgressStep("retime")).toBe(false);
  });
});
