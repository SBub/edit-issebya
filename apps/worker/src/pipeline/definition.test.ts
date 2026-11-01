import { describe, expect, it } from "vitest";
import { PIPELINE, type PipelineStep, type SourceRef, fingerprintsFor } from "./definition.ts";

const SOURCE: SourceRef = { etag: "9e107d9d372bb6826bd81d3542a419d6", bytes: 12_345 };

type Path = (string | number)[];

// Every leaf of a settings object, with a different value for it.
function leaves(value: unknown, path: Path = []): { path: Path; changed: unknown }[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, [...path, index]));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]));
  }
  const changed =
    typeof value === "number"
      ? value + 1
      : typeof value === "string"
        ? `${value}-changed`
        : typeof value === "boolean"
          ? !value
          : 0.5;
  return [{ path, changed }];
}

function withLeaf(settings: object, path: Path, changed: unknown): object {
  const copy = structuredClone(settings) as Record<string | number, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path.at(-1)!] = changed;
  return copy;
}

function replaced(index: number, step: PipelineStep): PipelineStep[] {
  return PIPELINE.map((original, at) => (at === index ? step : original));
}

function expectOnlyFromChanged(index: number, pipeline: PipelineStep[], label: string) {
  const before = fingerprintsFor(SOURCE);
  const after = fingerprintsFor(SOURCE, pipeline);
  PIPELINE.forEach((step, at) => {
    if (at < index) expect(after[step.name], `${label}: ${step.name}`).toBe(before[step.name]);
    else expect(after[step.name], `${label}: ${step.name}`).not.toBe(before[step.name]);
  });
}

describe("PIPELINE", () => {
  it("runs convert, transcribe and retime in that order", () => {
    expect(PIPELINE.map((step) => [step.name, step.reelStatus])).toEqual([
      ["convert", "converting"],
      ["transcribe", "transcribing"],
      ["retime", "retiming"],
    ]);
  });

  it("gives every output a distinct name within its step", () => {
    for (const step of PIPELINE) expect(new Set(step.outputs).size).toBe(step.outputs.length);
    expect(PIPELINE.find((s) => s.name === "retime")?.outputs).toEqual([
      "source.mp4",
      "transcript.json",
      "retime.json",
      "envelope.json",
    ]);
  });

  it("reads only outputs of earlier steps that exist", () => {
    const fingerprints = fingerprintsFor(SOURCE);
    PIPELINE.forEach((step, index) => {
      for (const { ref } of step.inputs(SOURCE, fingerprints)) {
        if ("source" in ref) continue;
        const producer = PIPELINE.findIndex((other) => other.name === ref.step);
        expect(producer).toBeGreaterThanOrEqual(0);
        expect(producer).toBeLessThan(index);
        expect(PIPELINE[producer]!.outputs).toContain(ref.file);
        expect(ref.fingerprint).toBe(fingerprints[ref.step]);
      }
    });
  });
});

describe("fingerprintsFor", () => {
  it("changes a step and every later one when any single setting changes", () => {
    PIPELINE.forEach((step, index) => {
      const all = leaves(step.settings);
      expect(all.length).toBeGreaterThan(0);
      for (const { path, changed } of all) {
        const settings = withLeaf(step.settings, path, changed);
        expectOnlyFromChanged(
          index,
          replaced(index, { ...step, settings }),
          `${step.name}.${path.join(".")}`,
        );
      }
    });
  });

  it("changes a step and every later one when its version changes", () => {
    PIPELINE.forEach((step, index) => {
      expectOnlyFromChanged(
        index,
        replaced(index, { ...step, version: step.version + 1 }),
        step.name,
      );
    });
  });

  it("changes every step when the source changes", () => {
    const before = fingerprintsFor(SOURCE);
    for (const source of [
      { ...SOURCE, bytes: SOURCE.bytes + 1 },
      { ...SOURCE, etag: "0".repeat(32) },
    ]) {
      const after = fingerprintsFor(source);
      for (const step of PIPELINE) expect(after[step.name]).not.toBe(before[step.name]);
    }
  });
});
