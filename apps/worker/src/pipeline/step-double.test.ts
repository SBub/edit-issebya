import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { type Tool, runToolsStep } from "../step-runner.ts";
import { PIPELINE } from "./definition.ts";
import { PIPELINE_FIXTURES, parseStepFault, stepDouble } from "./step-double.ts";

const transcribe = PIPELINE.find((step) => step.name === "transcribe")!;
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed manifest
const manifest = JSON.parse(await readFile(`${PIPELINE_FIXTURES}manifest.json`, "utf8")) as {
  steps: { name: string; fingerprint: string }[];
};
const FINGERPRINT = manifest.steps.find((step) => step.name === "transcribe")!.fingerprint;
const TIMEOUT = { timeout: 20_000 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "step-double-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function args(tool: Tool) {
  return {
    tool,
    tools: {
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      hyperframes: ["node", "hf"] as [string, string],
    },
    dir,
    files: {},
    settings: transcribe.settings,
    signal: new AbortController().signal,
  };
}

describe("stepDouble", () => {
  it("is off unless E2E_MOCK_STEPS is exactly true", () => {
    for (const flag of [undefined, "", "1", "TRUE", " true", "yes"]) {
      expect(stepDouble({ E2E_MOCK_STEPS: flag })).toBeNull();
    }
    expect(stepDouble({ E2E_MOCK_STEPS: "true" })).toBeTypeOf("function");
  });

  it("refuses a step whose fingerprint is not the fixture clip's", async () => {
    const double = stepDouble({ E2E_MOCK_STEPS: "true" })!;
    const never: Tool = () => Promise.reject(new Error("never spawned"));
    await expect(double(transcribe, args(never), "f".repeat(64))).rejects.toThrow(
      /knows only that one/,
    );
  });

  it("spawns the fake with the fault for its step only", async () => {
    const calls: string[][] = [];
    const tool: Tool = async (call) => {
      calls.push(call.args);
      return "";
    };
    const double = stepDouble({ E2E_MOCK_STEPS: "true", E2E_MOCK_STEP_FAULT: "transcribe:half" })!;
    expect(await double(transcribe, args(tool), FINGERPRINT)).toEqual({
      what: "transcribe (double)",
    });
    expect(calls[0]?.slice(1)).toEqual([
      "half",
      `${PIPELINE_FIXTURES}transcribe`,
      dir,
      "transcript.json",
    ]);
    const convert = PIPELINE.find((step) => step.name === "convert")!;
    const convertPrint = manifest.steps.find((step) => step.name === "convert")!.fingerprint;
    await double(convert, args(tool), convertPrint);
    expect(calls[1]?.[1]).toBe("none");
  });
});

describe("parseStepFault", () => {
  it("reads <step>:<signal|exit|half>", () => {
    expect(parseStepFault(undefined)).toBeNull();
    expect(parseStepFault(" ")).toBeNull();
    expect(parseStepFault("transcribe:signal")).toEqual({ step: "transcribe", fault: "signal" });
    expect(parseStepFault("convert:exit")).toEqual({ step: "convert", fault: "exit" });
    expect(parseStepFault("retime:half")).toEqual({ step: "retime", fault: "half" });
  });

  it("refuses anything else", () => {
    for (const raw of ["transcribe", "transcribe:boom", ":exit", "a:exit:b"]) {
      expect(() => parseStepFault(raw)).toThrow(/E2E_MOCK_STEP_FAULT/);
    }
  });
});

describe("the fake step, spawned for real through the step runner", () => {
  async function runDouble(env: Record<string, string>) {
    const { steps, calls } = recordingSteps();
    const double = stepDouble({ E2E_MOCK_STEPS: "true", ...env })!;
    const run = runToolsStep(stepContext(steps, { job: TEST_JOB }), {
      name: "transcribe",
      work: (tool) => double(transcribe, args(tool), FINGERPRINT),
    });
    return { run, calls };
  }

  it("writes each output as .part, then renames it", TIMEOUT, async () => {
    const { run } = await runDouble({});
    await run;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(dir)).toEqual(["transcript.json"]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readFile(join(dir, "transcript.json"))).toEqual(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
      await readFile(`${PIPELINE_FIXTURES}transcribe/transcript.json`),
    );
  });

  it("is killed by a signal, retried once, and fails", TIMEOUT, async () => {
    const { run, calls } = await runDouble({ E2E_MOCK_STEP_FAULT: "transcribe:signal" });
    await expect(run).rejects.toThrow(/signal/);
    expect(calls.filter((c) => c.call === "failed")).toHaveLength(2);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(dir)).toEqual([]);
  });

  it("exits 1 on purpose and is not retried", TIMEOUT, async () => {
    const { run, calls } = await runDouble({ E2E_MOCK_STEP_FAULT: "transcribe:exit" });
    await expect(run).rejects.toThrow(/failed on purpose/);
    expect(calls.filter((c) => c.call === "start")).toHaveLength(1);
  });
});
