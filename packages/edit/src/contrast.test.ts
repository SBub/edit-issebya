import { describe, expect, it } from "vitest";
import {
  byteLuminance,
  contrastRatio,
  isLightText,
  luminanceByte,
  relativeLuminance,
} from "./contrast.ts";

describe("relativeLuminance", () => {
  it("is 1 for white and 0 for black, in either case of hex digits", () => {
    expect(relativeLuminance("#FFFFFF")).toBe(1);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("refuses anything but #RRGGBB", () => {
    expect(() => relativeLuminance("#FFF")).toThrow(/#RRGGBB/);
  });
});

describe("contrastRatio", () => {
  it("gives the known WCAG pairs", () => {
    expect(contrastRatio(relativeLuminance("#FFFFFF"), relativeLuminance("#000000"))).toBe(21);
    expect(contrastRatio(relativeLuminance("#777777"), relativeLuminance("#FFFFFF"))).toBeCloseTo(
      4.48,
      2,
    );
    expect(contrastRatio(relativeLuminance("#B3E6FF"), relativeLuminance("#B3E6FF"))).toBe(1);
  });

  it("does not depend on the order", () => {
    expect(contrastRatio(0.2, 0.9)).toBe(contrastRatio(0.9, 0.2));
  });
});

describe("the stored byte", () => {
  it("rounds to 0..255 and back", () => {
    expect(luminanceByte(1)).toBe(255);
    expect(luminanceByte(0)).toBe(0);
    expect(luminanceByte(0.5)).toBe(128);
    expect(byteLuminance(255)).toBe(1);
  });
});

describe("isLightText", () => {
  it("calls the preset's colours light and black dark", () => {
    expect(isLightText("#FFFFFF")).toBe(true);
    expect(isLightText("#B3E6FF")).toBe(true);
    expect(isLightText("#000000")).toBe(false);
    expect(isLightText("#333333")).toBe(false);
  });
});
