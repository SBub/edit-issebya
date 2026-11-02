import { describe, expect, it } from "vitest";
import { errorTail } from "./errors.ts";

describe("errorTail", () => {
  it("keeps the message of an error", () => {
    expect(errorTail(new Error("source object missing"))).toContain("source object missing");
  });

  it("keeps only the last lines and characters", () => {
    const error = new Error("boom");
    error.stack = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const tail = errorTail(error, { lines: 3 });
    expect(tail).toBe("line 47\nline 48\nline 49");
    expect(errorTail(new Error("x".repeat(5000)), { chars: 100 })).toHaveLength(100);
  });

  it("formats a non-error value", () => {
    expect(errorTail("plain")).toBe("plain");
  });
});
