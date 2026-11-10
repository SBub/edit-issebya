import { FONT_PAIRS } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { faceStyle, pairOfProfile } from "./font-pair-faces";

describe("faceStyle", () => {
  it("draws a sample in its own family, weight and style", () => {
    expect(faceStyle(FONT_PAIRS.classic.artistic)).toEqual({
      fontFamily: '"Playfair Display Italic"',
      fontWeight: 400,
      fontStyle: "italic",
    });
    expect(faceStyle(FONT_PAIRS.classic.simple).fontStyle).toBe("normal");
  });
});

describe("pairOfProfile", () => {
  it("is the classic pair with no profile row, and the row's pair otherwise", () => {
    expect(pairOfProfile(null)).toBe("classic");
    expect(pairOfProfile(undefined)).toBe("classic");
    expect(pairOfProfile({ font_pair: "bold" })).toBe("bold");
    expect(pairOfProfile({ font_pair: "primary" })).toBe("classic");
  });
});
