/* eslint-disable security/detect-non-literal-fs-filename -- every path is inside the test's temp folder */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ErrorLine,
  MAX_LOG_BYTES,
  appendErrorLine,
  errorLogPath,
  formatLastFailures,
  logMessage,
} from "./dev-error-log.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dev-error-log-"));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

function line(extra: Partial<ErrorLine> = {}): ErrorLine {
  return {
    time: new Date(2026, 10, 3, 14, 2).toISOString(),
    job_id: "1a2b3c4d-0000-0000-0000-000000000000",
    job_kind: "change",
    reel_id: "r1",
    step: "decide",
    attempt: 1,
    failure_kind: "failed",
    message: "boom",
    ...extra,
  };
}

describe("errorLogPath", () => {
  it("uses WORKER_STATE_DIR, else the home folder's dev folder", () => {
    expect(errorLogPath({ WORKER_STATE_DIR: "/tmp/state" })).toBe("/tmp/state/errors.jsonl");
    expect(errorLogPath({ WORKER_STATE_DIR: " " })).toMatch(
      /\.edit-issebya-worker\/dev\/errors\.jsonl$/,
    );
  });
});

describe("appendErrorLine", () => {
  it("creates the folder and appends one JSON line per failure", () => {
    const path = join(dir, "nested", "errors.jsonl");
    appendErrorLine(path, line());
    appendErrorLine(path, line({ step: "convert" }));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as ErrorLine).step)).toEqual(["decide", "convert"]);
  });

  it("rotates at the size limit, keeping one older file", () => {
    const path = join(dir, "errors.jsonl");
    const rotated = join(dir, "errors.1.jsonl");
    writeFileSync(rotated, "old\n");
    writeFileSync(path, "x".repeat(MAX_LOG_BYTES));
    appendErrorLine(path, line());
    expect(readFileSync(rotated, "utf8")).toHaveLength(MAX_LOG_BYTES);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(dir, "errors.2.jsonl"))).toBe(false);
  });

  it("never throws when the folder cannot be written, and says so once", () => {
    chmodSync(dir, 0o500);
    const log = vi.fn();
    expect(() => appendErrorLine(join(dir, "sub", "errors.jsonl"), line(), log)).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(/^worker: error log not written: E[A-Z]+$/);
  });
});

describe("logMessage", () => {
  it("keeps the first line, scrubbed, at most 300 characters", () => {
    const token = ["sb", "secret", "abc123"].join("_");
    expect(logMessage(`\nfailed with ${token} for owner@example.com\nsecond`)).toBe(
      "failed with [redacted] for [redacted]",
    );
    expect(logMessage("y".repeat(400))).toHaveLength(300);
  });
});

describe("formatLastFailures", () => {
  it("prints the last failures in plain words, oldest first, across the rotation", () => {
    const path = join(dir, "errors.jsonl");
    appendErrorLine(join(dir, "errors.1.jsonl"), line({ step: "convert", message: "old one" }));
    appendErrorLine(
      path,
      line({ failure_kind: "answer_refused", rules: ["behind-caption", "safe-box"], rounds: 2 }),
    );
    appendErrorLine(
      path,
      line({ job_id: null, job_kind: null, step: null, attempt: null, failure_kind: "uncaught" }),
    );
    expect(formatLastFailures(path).split("\n")).toEqual([
      "14:02 convert (change, job 1a2b3c4d...): old one",
      "14:02 decide (change, job 1a2b3c4d...): the AI's answer failed twice; rules behind-caption, safe-box; 2 rounds",
      "14:02 worker: the worker crashed: boom",
    ]);
    expect(formatLastFailures(path, 1).split("\n")).toHaveLength(1);
  });

  it("says nothing was logged when the file is missing or empty", () => {
    const path = join(dir, "errors.jsonl");
    expect(formatLastFailures(path)).toBe(`No failures logged in ${path}.`);
    writeFileSync(path, "");
    expect(formatLastFailures(path)).toBe(`No failures logged in ${path}.`);
  });
});
