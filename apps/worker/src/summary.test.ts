import { describe, expect, it } from "vitest";
import { formatDuration, outputTail, stepSummary } from "./summary.ts";

describe("formatDuration", () => {
  it.each([
    [0, "under a second"],
    [999, "under a second"],
    [1000, "1 second"],
    [47_900, "47 seconds"],
    [60_000, "1 minute"],
    [61_000, "1 minute 1 second"],
    [360_000, "6 minutes"],
    [407_000, "6 minutes 47 seconds"],
    [3_600_000, "1 hour"],
    [3_720_000, "1 hour 2 minutes"],
    [3_725_000, "1 hour 2 minutes"],
    [7_200_000, "2 hours"],
  ])("%i ms is %s", (ms, words) => {
    expect(formatDuration(ms)).toBe(words);
  });
});

describe("stepSummary", () => {
  it.each([
    [
      { what: "background removed", wallMs: 407_000, sizeBytes: 51 * 1024 * 1024 },
      "background removed, 6 minutes 47 seconds, 51.0 MB",
    ],
    [
      { what: "footage received", wallMs: 120, sizeBytes: 512 },
      "footage received, under a second, 512 B",
    ],
    [{ what: "probe failed", wallMs: 2_000, sizeBytes: null }, "probe failed, 2 seconds"],
  ])("%o", (input, expected) => {
    expect(stepSummary(input)).toBe(expected);
  });
});

describe("outputTail", () => {
  it("keeps the last 20 lines", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n";
    const lines = outputTail(text).split("\n");
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 81}`));
    expect(lines).not.toContain("line 1");
  });

  it("keeps at most 4096 bytes, ending with the last line", () => {
    const text = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(1000, "x")).join("\n");
    const tail = outputTail(text);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(4096);
    expect(tail.endsWith(`19`.padEnd(1000, "x"))).toBe(true);
    expect(tail.startsWith("16")).toBe(true);
  });

  it("never splits a multibyte character in one long line", () => {
    const tail = outputTail("é€😀".repeat(2000));
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(4096);
    expect(tail).not.toContain("�");
    expect(tail.endsWith("😀")).toBe(true);
  });

  it("is empty for empty output and joins CRLF lines", () => {
    expect(outputTail("")).toBe("");
    expect(outputTail("a\r\nb\r\n")).toBe("a\nb");
  });
});
