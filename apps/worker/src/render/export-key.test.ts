import { describe, expect, it } from "vitest";
import { exportKey } from "./export-key.ts";

describe("exportKey", () => {
  it("puts the export under the prefix, the reel and its own id", () => {
    expect(exportKey("dev/", "r1", "e1")).toBe("dev/exports/r1/e1.mp4");
    expect(exportKey("", "r1", "e1")).toBe("exports/r1/e1.mp4");
  });

  it("refuses an id that would leave the reel's folder", () => {
    expect(() => exportKey("dev/", "r1", "../x")).toThrow(/invalid storage key/);
    expect(() => exportKey("dev/", "R1", "e1")).toThrow(/invalid storage key/);
  });
});
