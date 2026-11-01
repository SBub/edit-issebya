import { describe, expect, it } from "vitest";
import { cacheKey } from "./cache-key.ts";

describe("cacheKey", () => {
  it("places the file under the step and the fingerprint", () => {
    expect(cacheKey("dev/", "convert", "ab12", "converted.mp4")).toBe(
      "dev/cache/convert/ab12/converted.mp4",
    );
    expect(cacheKey("", "retime", "ab12", "retime.json")).toBe("cache/retime/ab12/retime.json");
  });

  it("refuses a key that could leave the store", () => {
    expect(() => cacheKey("", "convert", "..", "x")).toThrow("invalid storage key");
  });
});
