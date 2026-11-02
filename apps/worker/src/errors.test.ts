import { describe, expect, it } from "vitest";
import { errorTail, failureReason } from "./errors.ts";

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

describe("failureReason", () => {
  it("keeps the first line and the tool's last output lines, never the stack", () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `stderr ${i}`).join("\n");
    const reason = failureReason(new Error(`photo_images exited with 1\n${stderr}\n`));
    const lines = reason.split("\n");
    expect(lines[0]).toBe("Error: photo_images exited with 1");
    expect(lines).toHaveLength(21);
    expect(lines[1]).toBe("stderr 10");
    expect(lines.at(-1)).toBe("stderr 29");
    expect(reason).not.toContain("    at ");
  });

  it("bounds the output to the given characters", () => {
    const reason = failureReason(new Error(`probe exited with 1\n${"x".repeat(5000)}`));
    expect(reason).toBe(`Error: probe exited with 1\n${"x".repeat(2000)}`);
  });

  it("is the one line of a one-line error or value", () => {
    expect(failureReason(new Error("source object missing"))).toBe("Error: source object missing");
    expect(failureReason("plain")).toBe("plain");
  });
});
