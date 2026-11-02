import { describe, expect, it } from "vitest";
import { formatBytes } from "./format.ts";

describe("formatBytes", () => {
  it("matches the studio's format", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});
