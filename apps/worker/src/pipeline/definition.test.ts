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

// The changed step and every step that reads, directly or not, one of its
// outputs change; every other step keeps its fingerprint.
function expectOnlyFromChanged(index: number, pipeline: PipelineStep[], label: string) {
  const before = fingerprintsFor(SOURCE);
  const after = fingerprintsFor(SOURCE, pipeline);
  const changed = new Set([PIPELINE[index]!.name]);
  for (const step of PIPELINE.slice(index + 1)) {
    const reads = step.inputs(SOURCE, before).map(({ ref }) => ("step" in ref ? ref.step : null));
    if (reads.some((name) => name !== null && changed.has(name))) changed.add(step.name);
  }
  for (const step of PIPELINE) {
    if (changed.has(step.name)) {
      expect(after[step.name], `${label}: ${step.name}`).not.toBe(before[step.name]);
    } else {
      expect(after[step.name], `${label}: ${step.name}`).toBe(before[step.name]);
    }
  }
}

describe("PIPELINE", () => {
  it("runs the six fixed steps in order", () => {
    expect(PIPELINE.map((step) => [step.name, step.reelStatus])).toEqual([
      ["convert", "converting"],
      ["transcribe", "transcribing"],
      ["retime", "retiming"],
      ["remove_background", "removing_background"],
      ["head_track", "tracking_head"],
      ["preview_copies", "making_previews"],
    ]);
  });

  it("gives every output a distinct name within its step", () => {
    for (const step of PIPELINE) {
      expect(new Set(step.outputs.map((o) => o.file)).size).toBe(step.outputs.length);
    }
    expect(PIPELINE.find((s) => s.name === "retime")?.outputs.map((o) => o.file)).toEqual([
      "source.mp4",
      "transcript.json",
      "retime.json",
      "envelope.json",
    ]);
  });

  it("tags every output kept or rebuildable (B6)", () => {
    const keep = Object.fromEntries(
      PIPELINE.flatMap((step) => step.outputs.map((o) => [`${step.name}/${o.file}`, o.keep])),
    );
    for (const value of Object.values(keep)) expect(["kept", "rebuildable"]).toContain(value);
    expect(keep).toMatchObject({
      "convert/converted.mp4": "rebuildable",
      "remove_background/subject.webm": "rebuildable",
      "preview_copies/preview.mp4": "kept",
      "preview_copies/preview-subject.webm": "kept",
      "head_track/head-track.json": "kept",
    });
  });

  it("reads only outputs of earlier steps that exist", () => {
    const fingerprints = fingerprintsFor(SOURCE);
    PIPELINE.forEach((step, index) => {
      for (const { ref } of step.inputs(SOURCE, fingerprints)) {
        if ("source" in ref) continue;
        const producer = PIPELINE.findIndex((other) => other.name === ref.step);
        expect(producer).toBeGreaterThanOrEqual(0);
        expect(producer).toBeLessThan(index);
        expect(PIPELINE[producer]!.outputs.map((o) => o.file)).toContain(ref.file);
        expect(ref.fingerprint).toBe(fingerprints[ref.step]);
      }
    });
  });
});

describe("fingerprintsFor", () => {
  it("changes a step and every step reading from it when any single setting changes", () => {
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

  it("changes a step and every step reading from it when its version changes", () => {
    PIPELINE.forEach((step, index) => {
      expectOnlyFromChanged(
        index,
        replaced(index, { ...step, version: step.version + 1 }),
        step.name,
      );
    });
  });

  it("keeps the preview copies when only the head track changes", () => {
    const index = PIPELINE.findIndex((step) => step.name === "head_track");
    const step = PIPELINE[index]!;
    const before = fingerprintsFor(SOURCE);
    const after = fingerprintsFor(SOURCE, replaced(index, { ...step, version: step.version + 1 }));
    expect(after.head_track).not.toBe(before.head_track);
    expect(after.preview_copies).toBe(before.preview_copies);
  });

  it("re-runs background removal and every later step after a HyperFrames upgrade there", () => {
    const index = PIPELINE.findIndex((step) => step.name === "remove_background");
    const step = PIPELINE[index]!;
    const settings = { ...(step.settings as { hyperframes: string }), hyperframes: "9.9.9" };
    expectOnlyFromChanged(index, replaced(index, { ...step, settings }), "hyperframes");
    expect(PIPELINE.slice(index).map((s) => s.name)).toEqual([
      "remove_background",
      "head_track",
      "preview_copies",
    ]);
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
