import { describe, expect, it } from "vitest";
import { type FileRef, cacheKey, fingerprint } from "./fingerprint.ts";

const SOURCE: FileRef = { source: { etag: "9e107d9d372bb6826bd81d3542a419d6", bytes: 1234 } };
const PRODUCED: FileRef = { step: "convert", fingerprint: "a".repeat(64), file: "converted.mp4" };
const BASE = {
  inputs: [SOURCE, PRODUCED],
  settings: { fps: 30, nested: { npl: 100, list: ["aac"] }, off: null },
  version: 1,
};

describe("fingerprint", () => {
  it("is a stable SHA-256 hex", () => {
    expect(fingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(BASE)).toBe(fingerprint(structuredClone(BASE)));
  });

  it("ignores key order", () => {
    expect(
      fingerprint({
        version: 1,
        settings: { off: null, nested: { list: ["aac"], npl: 100 }, fps: 30 },
        inputs: [{ source: { bytes: 1234, etag: SOURCE.source.etag } }, PRODUCED],
      }),
    ).toBe(fingerprint(BASE));
  });

  it("changes with any input, setting or the version", () => {
    const base = fingerprint(BASE);
    const changed = [
      { ...BASE, inputs: [{ source: { etag: "0".repeat(32), bytes: 1234 } }, PRODUCED] },
      { ...BASE, inputs: [{ source: { etag: SOURCE.source.etag, bytes: 1235 } }, PRODUCED] },
      { ...BASE, inputs: [SOURCE, { ...PRODUCED, fingerprint: "b".repeat(64) }] },
      { ...BASE, inputs: [SOURCE, { ...PRODUCED, file: "other.mp4" }] },
      { ...BASE, inputs: [PRODUCED, SOURCE] },
      { ...BASE, settings: { ...BASE.settings, nested: { npl: 101, list: ["aac"] } } },
      { ...BASE, settings: { ...BASE.settings, nested: { npl: 100, list: ["opus"] } } },
      { ...BASE, settings: { ...BASE.settings, off: 0.4 } },
      { ...BASE, version: 2 },
    ];
    for (const value of changed) expect(fingerprint(value)).not.toBe(base);
  });

  it("refuses an undefined or non-finite setting", () => {
    expect(() => fingerprint({ ...BASE, settings: { a: undefined } })).toThrow();
    expect(() => fingerprint({ ...BASE, settings: { a: NaN } })).toThrow();
  });
});

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
