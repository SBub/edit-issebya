import { describe, expect, it } from "vitest";
import {
  PIPELINE,
  type PipelineStep,
  type SourceRef,
  fingerprintsFor,
  outputFiles,
  retentionOf,
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

// The changed step and every step reading its outputs, directly or through
// another step.
function dependents(index: number): Set<string> {
  const fingerprints = fingerprintsFor(SOURCE);
  const changed = new Set([PIPELINE[index]!.name]);
  for (const step of PIPELINE) {
    const reads = step.inputs(SOURCE, fingerprints).map((input) => input.ref);
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
    } else {
      expect(after[step.name], `${label}: ${step.name}`).toBe(before[step.name]);
    }
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
    for (const step of PIPELINE) expect(new Set(outputFiles(step)).size).toBe(step.outputs.length);
    expect(outputFiles(PIPELINE.find((s) => s.name === "retime")!)).toEqual([
      "source.mp4",
      "transcript.json",
      "retime.json",
      "envelope.json",
    ]);
  });

  it("tags every output kept or rebuildable", () => {
    const tags = Object.fromEntries(
      PIPELINE.flatMap((step) =>
        step.outputs.map((output) => [`${step.name}/${output.file}`, output.retention]),
      ),
    );
    expect(tags).toEqual({
      "convert/converted.mp4": "rebuildable",
      "transcribe/transcript.json": "kept",
      "retime/source.mp4": "rebuildable",
      "retime/transcript.json": "kept",
      "retime/retime.json": "kept",
      "retime/envelope.json": "kept",
      "remove_background/subject.webm": "rebuildable",
      "head_track/head-track.json": "kept",
      "preview_copies/footage-preview.mp4": "kept",
      "preview_copies/subject-preview.webm": "kept",
    });
    for (const tag of Object.values(tags)) expect(["kept", "rebuildable"]).toContain(tag);
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

  it("re-runs background removal, head tracking and previews on a HyperFrames upgrade", () => {
    const index = PIPELINE.findIndex((step) => step.name === "remove_background");
    const step = PIPELINE[index]!;
    const before = fingerprintsFor(SOURCE);
    const after = fingerprintsFor(
      SOURCE,
      replaced(index, { ...step, settings: { ...step.settings, hyperframes: "0.0.0-changed" } }),
    );
    for (const name of ["remove_background", "head_track", "preview_copies"]) {
      expect(after[name], name).not.toBe(before[name]);
    }
    for (const name of ["convert", "transcribe", "retime"]) {
      expect(after[name], name).toBe(before[name]);
    }
  });

  it("does not re-run the previews when only head tracking changes", () => {
    const index = PIPELINE.findIndex((step) => step.name === "head_track");
    const before = fingerprintsFor(SOURCE);
    const after = fingerprintsFor(
      SOURCE,
      replaced(index, { ...PIPELINE[index]!, version: PIPELINE[index]!.version + 1 }),
    );
    expect(after.head_track).not.toBe(before.head_track);
    expect(after.preview_copies).toBe(before.preview_copies);
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

describe("retentionOf", () => {
  it("tags the three heavy outputs rebuildable and every other kept", () => {
    const rebuildable = [
      ["convert", "converted.mp4"],
      ["retime", "source.mp4"],
      ["remove_background", "subject.webm"],
    ];
    for (const [step, file] of rebuildable) expect(retentionOf(step!, file!)).toBe("rebuildable");
    for (const step of PIPELINE) {
      for (const file of outputFiles(step)) {
        if (rebuildable.some(([s, f]) => s === step.name && f === file)) continue;
        expect(retentionOf(step.name, file)).toBe("kept");
      }
    }
  });

  it("gives null for an unknown step or file", () => {
    expect(retentionOf("convert", "other.mp4")).toBeNull();
    expect(retentionOf("render", "export.mp4")).toBeNull();
  });
});
