import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../failures.ts";
import type { Tool } from "../step-runner.ts";
import { PIPELINE, type PipelineStep } from "./definition.ts";
import { stepDoubles } from "./step-double.ts";
import type { ToolPaths } from "./tools.ts";

const ON = { E2E_MOCK_STORAGE: "true" };
const TOOLS: ToolPaths = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: ["node", "hf"] };
const NEVER: Tool = () => Promise.reject(new Error("the double never runs a tool"));

let root: string;
let fixtures: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "step-double-"));
  fixtures = join(root, "fixtures");
  dir = join(root, "step");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(join(fixtures, "convert"), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(dir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await writeFile(join(fixtures, "convert", "converted.mp4"), "0123456789");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function convertOf(pipeline: readonly PipelineStep[]): PipelineStep {
  return pipeline.find((step) => step.name === "convert")!;
}

function runConvert(pipeline: readonly PipelineStep[], signal = new AbortController().signal) {
  return convertOf(pipeline).run({
    tool: NEVER,
    tools: TOOLS,
    dir,
    files: { source: join(root, "source") },
    settings: {},
    signal,
  });
}

describe("stepDoubles", () => {
  it("leaves the pipeline as it is without the storage flag or the variable", () => {
    expect(stepDoubles({ E2E_MOCK_STEP_RUN: "convert:full" }, fixtures)(PIPELINE)).toBe(PIPELINE);
    expect(
      stepDoubles({ E2E_MOCK_STORAGE: "1", E2E_MOCK_STEP_RUN: "convert:full" }, fixtures)(PIPELINE),
    ).toBe(PIPELINE);
    expect(stepDoubles(ON, fixtures)(PIPELINE)).toBe(PIPELINE);
  });

  it("refuses an unknown step or mode", () => {
    expect(() =>
      stepDoubles({ ...ON, E2E_MOCK_STEP_RUN: "nope:full" }, fixtures)(PIPELINE),
    ).toThrow(/names no pipeline step/);
    expect(() =>
      stepDoubles({ ...ON, E2E_MOCK_STEP_RUN: "convert:wobble" }, fixtures)(PIPELINE),
    ).toThrow(/must be <step>:/);
  });

  it("replaces only the named step, keeping its fingerprint parts", () => {
    const doubled = stepDoubles({ ...ON, E2E_MOCK_STEP_RUN: "convert:full" }, fixtures)(PIPELINE);
    doubled.forEach((step, index) => {
      expect(step.name).toBe(PIPELINE[index]!.name);
      expect(step.version).toBe(PIPELINE[index]!.version);
      expect(step.settings).toBe(PIPELINE[index]!.settings);
      expect(step.run === PIPELINE[index]!.run).toBe(step.name !== "convert");
    });
  });

  it("full: writes the committed output under its final name only", async () => {
    const doubled = stepDoubles({ ...ON, E2E_MOCK_STEP_RUN: "convert:full" }, fixtures)(PIPELINE);
    await runConvert(doubled);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(dir)).toEqual(["converted.mp4"]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readFile(join(dir, "converted.mp4"), "utf8")).toBe("0123456789");
  });

  it("half: writes half of the output as .part, says so, and hangs until aborted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const doubled = stepDoubles({ ...ON, E2E_MOCK_STEP_RUN: "convert:half" }, fixtures)(PIPELINE);
    const controller = new AbortController();
    const running = runConvert(doubled, controller.signal);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("e2e: convert partial written"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect((await stat(join(dir, "converted.mp4.part"))).size).toBe(5);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(dir)).toEqual(["converted.mp4.part"]);
    controller.abort(new Error("killed"));
    await expect(running).rejects.toThrow("killed");
  });

  it("fail-transient: fails every time as a tool killed by a signal", async () => {
    const doubled = stepDoubles(
      { ...ON, E2E_MOCK_STEP_RUN: "convert:fail-transient" },
      fixtures,
    )(PIPELINE);
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await runConvert(doubled).catch((caught: unknown) => caught);
      expect(classifyFailure(error)).toBe("transient");
    }
  });
});
