import { describe, expect, it } from "vitest";
import { formatBytes, receivedSummary } from "./format.ts";

describe("formatBytes", () => {
  it("matches the studio's format", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});

describe("receivedSummary", () => {
  it("names the size", () => {
    expect(receivedSummary(Math.round(12.3 * 1024 * 1024))).toBe("footage received, 12.3 MB");
  });
});
