import { describe, expect, it } from "vitest";
import { REELS, reelVariant } from "./reels";

describe("reelVariant", () => {
  it("is the reel's 1-based position in REELS", () => {
    expect(reelVariant("poster-reel-04")).toBe(1);
    expect(reelVariant("statement-reel-01")).toBe(2);
    expect(reelVariant("editorial-reel-02")).toBe(3);
  });

  it("follows the REELS order for every reel", () => {
    REELS.forEach((reel, index) => expect(reelVariant(reel.id)).toBe(index + 1));
  });

  it("is null for an unknown id", () => {
    expect(reelVariant("missing")).toBeNull();
  });
});
