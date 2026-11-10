import { describe, expect, it } from "vitest";
import { MASK_STEP } from "./cutout/spans.ts";
import { STEP as DECIDE } from "./decide/run-decide.ts";
import { STEP as FIRST_VERSION } from "./first-version.ts";
import { STEP as DESCRIBE_PHOTO } from "./photos/describe-photo.ts";
import { STEP as PHOTO_IMAGES } from "./photos/photo-images.ts";
import { PIPELINE } from "./pipeline/definition.ts";
import { CHECK_FOOTAGE_STEP } from "./pipeline/run-pipeline.ts";
import { STEP as PREVIEW_COPIES } from "./preview-copies-record.ts";
import { STEP as RELAYOUT } from "./relayout.ts";
import { STEP as RENDER } from "./render/render-step.ts";
import { STEP as RESTORE } from "./restore-step.ts";
import { STEP_NAMES } from "./step-names.ts";

describe("STEP_NAMES", () => {
  const used = new Set<string>([
    ...PIPELINE.map((step) => step.name),
    CHECK_FOOTAGE_STEP,
    PREVIEW_COPIES,
    FIRST_VERSION,
    DECIDE,
    MASK_STEP,
    RESTORE,
    RENDER,
    RELAYOUT,
    DESCRIBE_PHOTO,
    PHOTO_IMAGES,
  ]);

  it("names every step a module runs", () => {
    for (const name of used) expect(STEP_NAMES).toContain(name);
  });

  it("names no step that no module runs, each once", () => {
    for (const name of STEP_NAMES) expect(used.has(name), name).toBe(true);
    expect(new Set(STEP_NAMES).size).toBe(STEP_NAMES.length);
  });
});
