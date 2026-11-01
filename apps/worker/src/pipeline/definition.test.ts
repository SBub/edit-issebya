import { describe, expect, it } from "vitest";
import {
  PIPELINE,
  type PipelineStep,
  type SourceRef,
  fingerprintsFor,
  outputFiles,
} from "./definition.ts";

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

// The step at `index` and every step that reads its outputs, directly or
// through another step.
function dependents(index: number): Set<string> {
  const fingerprints = fingerprintsFor(SOURCE);
  const changed = new Set([PIPELINE[index]!.name]);
  for (const step of PIPELINE.slice(index + 1)) {
    const reads = step.inputs(SOURCE, fingerprints).map(({ ref }) => ref);
    if (reads.some((ref) => "step" in ref && changed.has(ref.step))) changed.add(step.name);
  }
  return changed;
}

function expectOnlyFromChanged(index: number, pipeline: PipelineStep[], label: string) {
  const before = fingerprintsFor(SOURCE);
  const after = fingerprintsFor(SOURCE, pipeline);
  const changed = dependents(index);
  for (const step of PIPELINE) {
    if (changed.has(step.name)) {
      expect(after[step.name], `${label}: ${step.name}`).not.toBe(before[step.name]);
    } else expect(after[step.name], `${label}: ${step.name}`).toBe(before[step.name]);
  }
}

describe("PIPELINE", () => {
  it("runs the six fixed steps in order, each with its reel status", () => {
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
      expect(new Set(outputFiles(step)).size).toBe(step.outputs.length);
    }
    expect(Object.fromEntries(PIPELINE.map((step) => [step.name, outputFiles(step)]))).toEqual({
      convert: ["converted.mp4"],
      transcribe: ["transcript.json"],
      retime: ["source.mp4", "transcript.json", "retime.json", "envelope.json"],
      remove_background: ["subject.webm"],
      head_track: ["head-track.json"],
      preview_copies: ["footage.mp4", "subject.webm"],
    });
  });

  it("tags every output kept or rebuildable: only the heavy, cheap-to-remake ones rebuildable", () => {
    for (const step of PIPELINE) {
      for (const output of step.outputs) expect(["kept", "rebuildable"]).toContain(output.keep);
    }
    const rebuildable = PIPELINE.flatMap((step) =>
      step.outputs
        .filter((output) => output.keep === "rebuildable")
        .map((o) => `${step.name}/${o.file}`),
    );
    expect(rebuildable).toEqual([
      "convert/converted.mp4",
      "retime/source.mp4",
      "remove_background/subject.webm",
    ]);
    const previews = PIPELINE.find((step) => step.name === "preview_copies")!;
    expect(previews.outputs.map((output) => output.keep)).toEqual(["kept", "kept"]);
  });

  it("reads only outputs of earlier steps that exist", () => {
    const fingerprints = fingerprintsFor(SOURCE);
    PIPELINE.forEach((step, index) => {
      for (const { ref } of step.inputs(SOURCE, fingerprints)) {
        if ("source" in ref) continue;
        const producer = PIPELINE.findIndex((other) => other.name === ref.step);
        expect(producer).toBeGreaterThanOrEqual(0);
        expect(producer).toBeLessThan(index);
        expect(outputFiles(PIPELINE[producer]!)).toContain(ref.file);
        expect(ref.fingerprint).toBe(fingerprints[ref.step]);
      }
    });
  });
});

describe("fingerprintsFor", () => {
  it("changes a step and every step reading it when any single setting changes", () => {
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

  it("changes a step and every step reading it when its version changes", () => {
    PIPELINE.forEach((step, index) => {
      expectOnlyFromChanged(
        index,
        replaced(index, { ...step, version: step.version + 1 }),
        step.name,
      );
    });
  });

  it("changes only head tracking and the previews after the cut-out", () => {
    expect([
      ...dependents(PIPELINE.findIndex((step) => step.name === "remove_background")),
    ]).toEqual(["remove_background", "head_track", "preview_copies"]);
    expect([...dependents(PIPELINE.findIndex((step) => step.name === "head_track"))]).toEqual([
      "head_track",
    ]);
  });

  it("changes the cut-out and every later step, none before, with the HyperFrames version", () => {
    const index = PIPELINE.findIndex((step) => step.name === "remove_background");
    const step = PIPELINE[index]!;
    const settings = { ...step.settings, hyperframes: "0.0.1" };
    const after = fingerprintsFor(SOURCE, replaced(index, { ...step, settings }));
    const before = fingerprintsFor(SOURCE);
    for (const name of ["convert", "transcribe", "retime"]) expect(after[name]).toBe(before[name]);
    for (const name of ["remove_background", "head_track", "preview_copies"]) {
      expect(after[name]).not.toBe(before[name]);
    }
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
