import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PipelineStep, type StepRunArgs, outputFiles } from "./definition.ts";

type Env = Record<string, string | undefined>;

// The committed outputs of every fixed step for the fixture clip
// (`yarn workspace @edit-issebya/worker fixtures:pipeline`).
export const PIPELINE_FIXTURES = fileURLToPath(
  new URL("../../../../fixtures/pipeline/", import.meta.url),
);

// The double's process: copies a step's fixture outputs, or fails on purpose.
const FAKE_STEP = fileURLToPath(new URL("./fake-step.ts", import.meta.url));

export const STEP_FAULTS = ["signal", "exit", "half"] as const;
export type StepFault = (typeof STEP_FAULTS)[number];

// How a fixed step that must run is run: the step's own `run`, or the double.
export type RunStep = (
  step: PipelineStep,
  args: StepRunArgs<object>,
  fingerprint: string,
) => Promise<{ what: string }>;

// E2E_MOCK_STEP_FAULT names the step that fails and how: the step, a colon,
// then signal, exit or half.
export function parseStepFault(raw: string | undefined): { step: string; fault: StepFault } | null {
  const text = raw?.trim();
  if (!text) return null;
  const [step, fault, ...rest] = text.split(":");
  if (!step || rest.length > 0 || !STEP_FAULTS.includes(fault as StepFault)) {
    throw new Error(
      `E2E_MOCK_STEP_FAULT must be <step>:<${STEP_FAULTS.join("|")}>, got ${JSON.stringify(text)}`,
    );
  }
  return { step, fault: fault as StepFault };
}

function fixtureFingerprints(): Map<string, string> {
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed manifest
    readFileSync(`${PIPELINE_FIXTURES}manifest.json`, "utf8"),
  ) as { steps: { name: string; fingerprint: string }[] };
  return new Map(manifest.steps.map((step) => [step.name, step.fingerprint]));
}

// The pipeline step double for specs: only when E2E_MOCK_STEPS is exactly
// "true", else null. A fixed step that must run spawns the fake through the
// step's own tool (so the step runner measures it, sees its exit and retries
// it like a real tool), which writes the committed fixture outputs as
// `<file>.part` then renames them. It knows only the fixture clip: a step
// whose fingerprint is not the manifest's is refused. E2E_MOCK_STEP_FAULT
// makes one step fail on purpose.
export function stepDouble(env: Env = process.env): RunStep | null {
  if (env.E2E_MOCK_STEPS !== "true") return null;
  const fault = parseStepFault(env.E2E_MOCK_STEP_FAULT);
  const known = fixtureFingerprints();
  return async (step, args, fingerprint) => {
    if (known.get(step.name) !== fingerprint) {
      throw new Error(
        `step double: ${step.name} ${fingerprint} is not the fixture clip's; it knows only that one`,
      );
    }
    await args.tool({
      file: process.execPath,
      args: [
        FAKE_STEP,
        fault?.step === step.name ? fault.fault : "none",
        `${PIPELINE_FIXTURES}${step.name}`,
        args.dir,
        ...outputFiles(step),
      ],
      env: { ...process.env, ...env, E2E_MOCK_STEPS: "true" },
    });
    return { what: `${step.name} (double)` };
  };
}
