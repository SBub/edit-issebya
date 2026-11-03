import { describe, expect, it } from "vitest";
import { MIN_LARGE_TEXT_CONTRAST, contrastRatio } from "./contrast.ts";

describe("contrastRatio", () => {
  it("is 21 for white on black, either way round", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it("is 1 for a colour on itself", () => {
    expect(contrastRatio("#B3E6FF", "#B3E6FF")).toBe(1);
  });

  it("passes the style's accent on its background and fails white on light grey", () => {
    expect(contrastRatio("#B3E6FF", "#121212")).toBeGreaterThanOrEqual(MIN_LARGE_TEXT_CONTRAST);
    expect(contrastRatio("#FFFFFF", "#F0F0F0")).toBeLessThan(MIN_LARGE_TEXT_CONTRAST);
  });
});
