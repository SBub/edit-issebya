import { describe, expect, it } from "vitest";
import { fontPairOfRow } from "./font-pair-store.ts";

describe("fontPairOfRow", () => {
  it("is the classic pair for an owner with no profile row", () => {
    expect(fontPairOfRow(null)).toBe("classic");
  });

  it("is the pair the row names", () => {
    expect(fontPairOfRow({ font_pair: "retro" })).toBe("retro");
    expect(fontPairOfRow({ font_pair: "bold" })).toBe("bold");
  });

  it("refuses a name outside the six, never guessing a pair", () => {
    expect(() => fontPairOfRow({ font_pair: "primary" })).toThrow(/not one of the six/);
    expect(() => fontPairOfRow({})).toThrow(/not one of the six/);
  });
});
