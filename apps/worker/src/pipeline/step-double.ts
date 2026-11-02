// Test only: E2E_MOCK_STEP_RUN, a step name and a mode, replaces one fixed
// step's tool run, so a spec can crash, finish or fail a named step with no
// real tool (app_docs/failures.md). On only when E2E_MOCK_STORAGE is exactly "true".
//   half            writes the first half of the committed output as `.part`,
//                   logs `e2e: <step> partial written`, then hangs until killed
//   full            copies the committed outputs through a temporary name
//   fail-transient  fails every time as a tool killed by SIGKILL (transient)
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";
import { outputFiles } from "./definition.ts";

type Env = Record<string, string | undefined>;

const MODES = ["half", "full", "fail-transient"] as const;
type Mode = (typeof MODES)[number];

const DEFAULT_FIXTURES = new URL("../../../../fixtures/pipeline/", import.meta.url).pathname;

function parse(value: string): { step: string; mode: Mode } {
  const [step, mode, ...rest] = value.split(":");
  if (!step || !mode || rest.length > 0 || !MODES.includes(mode as Mode)) {
    throw new Error(`E2E_MOCK_STEP_RUN must be <step>:${MODES.join("|")}, not ${value}`);
  }
  return { step, mode: mode as Mode };
}

function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function doubled(step: PipelineStep, mode: Mode, fixtures: string): PipelineStep {
  const files = outputFiles(step);
  const committed = (file: string) => join(fixtures, step.name, file);
  return {
    ...step,
    async run({ dir, signal }) {
      if (mode === "fail-transient") {
        throw Object.assign(new Error(`e2e: ${step.name} killed by SIGKILL`), {
          exit: { code: null, signal: "SIGKILL", stdout: "" },
        });
      }
      if (mode === "half") {
        const first = files[0]!;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
        const bytes = await readFile(committed(first));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
        await writeFile(
          join(dir, `${first}.part`),
          bytes.subarray(0, Math.floor(bytes.length / 2)),
        );
        console.log(`e2e: ${step.name} partial written`);
        return hangUntilAborted(signal);
      }
      for (const file of files) {
        const partial = join(dir, `${file}.part`);
        await copyFile(committed(file), partial);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
        await rename(partial, join(dir, file));
      }
      return { what: `${step.reusedWhat} (e2e double)` };
    },
  };
}

// The pipeline with the named step's run replaced, or unchanged when the
// variable is unset or the storage flag is off. An unknown step or mode throws
// at job start.
export function stepDoubles(env: Env = process.env, fixtures: string = DEFAULT_FIXTURES) {
  return (pipeline: readonly PipelineStep[]): readonly PipelineStep[] => {
    const value = env.E2E_MOCK_STEP_RUN?.trim();
    if (env.E2E_MOCK_STORAGE !== "true" || !value) return pipeline;
    const { step, mode } = parse(value);
    if (!pipeline.some((candidate) => candidate.name === step)) {
      throw new Error(`E2E_MOCK_STEP_RUN names no pipeline step: ${step}`);
    }
    return pipeline.map((candidate) =>
      candidate.name === step ? doubled(candidate, mode, fixtures) : candidate,
    );
  };
}
