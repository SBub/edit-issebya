import { describe, expect, it } from "vitest";
import {
  REEL_COLUMNS,
  REEL_DETAIL_COLUMNS,
  REEL_STATUSES,
  formatBytes,
  formatCreatedAt,
  isReelId,
  reelName,
} from "./reels";

describe("isReelId", () => {
  it("accepts a uuid", () => {
    expect(isReelId("0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10")).toBe(true);
    expect(isReelId("0B9F6C1E-3C1D-4C8E-9A51-2F4D7B6E8A10")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isReelId("not-a-uuid")).toBe(false);
    expect(isReelId("")).toBe(false);
    expect(isReelId("0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10x")).toBe(false);
    expect(isReelId("' or 1=1 --")).toBe(false);
  });
});

describe("formatCreatedAt", () => {
  it("formats in UTC", () => {
    expect(formatCreatedAt("2026-10-31T09:05:00Z")).toBe("31 Oct 2026, 09:05 UTC");
  });
});

describe("reelName", () => {
  it("falls back for a missing name", () => {
    expect(reelName({ source_name: null })).toBe("Untitled reel");
    expect(reelName({ source_name: "  " })).toBe("Untitled reel");
    expect(reelName({ source_name: "beach.mov" })).toBe("beach.mov");
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(null)).toBe("Unknown size");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });
});

describe("columns", () => {
  it("never selects every column", () => {
    expect(REEL_COLUMNS).not.toContain("*");
    expect(REEL_DETAIL_COLUMNS).not.toContain("*");
  });
});

describe("REEL_STATUSES", () => {
  it("matches the check constraint of public.reels", () => {
    expect(REEL_STATUSES).toEqual([
      "uploading",
      "uploaded",
      "received",
      "checking_footage",
      "converting",
      "transcribing",
      "retiming",
      "removing_background",
      "tracking_head",
      "making_previews",
      "processed",
      "failed",
      "refused",
    ]);
  });
});
