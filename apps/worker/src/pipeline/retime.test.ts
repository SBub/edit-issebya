import { describe, expect, it } from "vitest";
import { RETIME_PRESET } from "./retime-preset.ts";
import { retimeSummary } from "./retime.ts";

describe("retimeSummary", () => {
  it("names the length and speed alone when no pause is left", () => {
    expect(retimeSummary(48.72, [], [], RETIME_PRESET)).toBe("retimed to 48.7 seconds, 1.05x");
  });

  it("names the pauses still longer than maxPauseSeconds and their total", () => {
    expect(retimeSummary(60, [[1, 1.5]], [], RETIME_PRESET)).toBe(
      "retimed to 60.0 seconds, 1.05x, 1 pause over 0.3 s left, 0.5 s in all",
    );
    expect(
      retimeSummary(
        60,
        [
          [1, 1.5],
          [10, 11.2],
        ],
        [],
        RETIME_PRESET,
      ),
    ).toBe("retimed to 60.0 seconds, 1.05x, 2 pauses over 0.3 s left, 1.7 s in all");
  });

  it("names every possible missed word kept, with its time", () => {
    expect(retimeSummary(56.1, [], [[49.63, 50.01]], RETIME_PRESET)).toBe(
      "retimed to 56.1 seconds, 1.05x, 1 possible missed word kept (sound at speech level in a pause) at 49.6 to 50.0 s",
    );
    expect(
      retimeSummary(
        60,
        [[1, 1.5]],
        [
          [12.3, 12.8],
          [40.12, 40.61],
        ],
        RETIME_PRESET,
      ),
    ).toBe(
      "retimed to 60.0 seconds, 1.05x, 1 pause over 0.3 s left, 0.5 s in all, 2 possible missed words kept (sound at speech level in a pause) at 12.3 to 12.8 s, 40.1 to 40.6 s",
    );
  });
});
