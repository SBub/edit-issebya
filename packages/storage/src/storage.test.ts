import { describe, expect, it } from "vitest";
import { keyPrefix } from "./storage.ts";

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
