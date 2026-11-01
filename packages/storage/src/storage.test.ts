import { describe, expect, it } from "vitest";
import { attachmentDisposition, isDownloadName, keyPrefix } from "./storage.ts";

describe("keyPrefix", () => {
  it("trims, allows empty and refuses malformed prefixes", () => {
    expect(keyPrefix({})).toBe("");
    expect(keyPrefix({ R2_KEY_PREFIX: " dev/ " })).toBe("dev/");
    expect(keyPrefix({ R2_KEY_PREFIX: "a/b_c/" })).toBe("a/b_c/");
    expect(keyPrefix({ R2_KEY_PREFIX: "dev" })).toBeNull();
    expect(keyPrefix({ R2_KEY_PREFIX: "/dev/" })).toBeNull();
    expect(keyPrefix({ R2_KEY_PREFIX: "Dev/" })).toBeNull();
  });
});

describe("isDownloadName", () => {
  it("accepts plain lower-case names and refuses anything that needs quoting", () => {
    expect(isDownloadName("reel-ab12cd34-20261101-0930.mp4")).toBe(true);
    for (const name of ["", ".mp4", "A.mp4", "a b.mp4", 'a".mp4', "a/b.mp4", "a;b.mp4"]) {
      expect(isDownloadName(name)).toBe(false);
    }
  });

  it("builds the attachment header only for an accepted name", () => {
    expect(attachmentDisposition("a.mp4")).toBe('attachment; filename="a.mp4"');
    expect(() => attachmentDisposition('a".mp4')).toThrow(/invalid download name/);
  });
});
