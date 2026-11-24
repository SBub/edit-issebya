// `yarn workspace @edit-issebya/worker eval <command> [options]`, where command is judge, curator, compare or snapshot: the
// one way to run the evals (app_docs/evals.md). Every command first refreshes the
// stale snapshots of the owner's labelled reels (`evals/refresh.ts`), the only
// eval step that reads the app's database and storage; then the eval reads the
// dataset it left. The routing is in `evals/command.ts`; this file wires the
// real adapters to it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { aiRunner } from "./ai.ts";
import { createAiObserver } from "./ai-observability.ts";
import { workerConfig } from "./config.ts";
import { editMeasurer } from "./edit-measurer.ts";
import { posthogPromptSource } from "./prompts/posthog-source.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";
import { type EvalCommand, EVAL_USAGE, runEvalCommand } from "./evals/command.ts";
import { readDraftPrompt } from "./evals/draft-prompt.ts";
import { posthogEvals } from "./evals/posthog-evals.ts";
import { refreshDataset, refreshedPosthog } from "./evals/refresh.ts";
import { runCuratorCompare } from "./evals/run-compare.ts";
import { runJudgeEval } from "./evals/run-eval.ts";
import { workerCuratorSources } from "./evals/worker-sources.ts";
import { createTelemetry } from "./telemetry.ts";

// The PostHog dataset `owner-reels`: the reels the owner labelled by hand.
const OWNER_REELS_DATASET = "01a1cf52-f6c3-7182-a7d9-5681010286ce";
// Where reports go: `apps/worker/eval-output/`, gitignored.
const OUTPUT_DIR = fileURLToPath(new URL("../eval-output/", import.meta.url));
// The repository's root: a draft prompt may not be read from inside it.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_LABEL = "production";

// The refresh step's reads and writes, and the dataset's: the same for every command.
function wiring() {
  const config = workerConfig();
  return {
    posthog: posthogEvals(process.env),
    sources: workerCuratorSources(workerSupabase(config), workerStorage(), config.keyPrefix),
  };
}

async function saveReport(fileName: string, html: string): Promise<string> {
  const path = `${OUTPUT_DIR}${fileName}`;
  /* eslint-disable security/detect-non-literal-fs-filename -- the eval's own output folder */
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path, html);
  /* eslint-enable security/detect-non-literal-fs-filename */
  return path;
}

// A draft prompt read from a local file outside the repository.
async function draftOf(path: string | undefined) {
  if (path === undefined) return undefined;
  return readDraftPrompt({
    path,
    repoRoot: REPO_ROOT,
    /* eslint-disable-next-line security/detect-non-literal-fs-filename -- the draft the owner named, outside the repository */
    read: (file) => readFile(file, "utf8"),
  });
}

// The environment of a prompt source that serves the prompts at a label.
function envAt(label: string): NodeJS.ProcessEnv {
  return { ...process.env, POSTHOG_PROMPT_LABEL: label };
}

async function judge(command: Extract<EvalCommand, { kind: "judge" }>): Promise<void> {
  // `--label` picks the judge prompt's label; without it, POSTHOG_PROMPT_LABEL.
  const env = command.label ? { ...process.env, POSTHOG_PROMPT_LABEL: command.label } : process.env;
  const telemetry = createTelemetry();
  // Every judge call is one PostHog generation event (app_docs/measurement.md).
  const aiObserver = createAiObserver("eval", env);
  try {
    const draft = await draftOf(command.promptFile);
    const { posthog, sources } = wiring();
    const refreshed = await refreshedPosthog(
      posthog,
      { datasetId: OWNER_REELS_DATASET, dryRun: command.dryRun, reel: command.reel },
      { sources },
    );
    await runJudgeEval(
      {
        datasetId: OWNER_REELS_DATASET,
        dryRun: command.dryRun,
        reel: command.reel,
        ...(draft ? { draft } : {}),
      },
      {
        posthog: refreshed,
        prompts: posthogPromptSource(env),
        ai: aiRunner(env, aiObserver),
        telemetry,
        saveReport,
      },
    );
  } finally {
    await telemetry.shutdown();
    await aiObserver.shutdown();
  }
}

// The curator at each label in turn (one table for all): `curator` runs one,
// `compare` the production prompt and then the label under test.
async function curatorAt(
  labels: string[],
  command: { dryRun: boolean; reel?: string; repeats: number },
): Promise<void> {
  const telemetry = createTelemetry();
  // Every curator call is one PostHog generation event (app_docs/measurement.md).
  const aiObserver = createAiObserver("eval");
  try {
    const { posthog, sources } = wiring();
    const refreshed = await refreshedPosthog(
      posthog,
      { datasetId: OWNER_REELS_DATASET, dryRun: command.dryRun, reel: command.reel },
      { sources },
    );
    await runCuratorCompare(
      {
        datasetId: OWNER_REELS_DATASET,
        dryRun: command.dryRun,
        reel: command.reel,
        repeats: command.repeats,
        labels,
      },
      {
        posthog: refreshed,
        promptsAt: (label) => posthogPromptSource(envAt(label)),
        ai: aiRunner(process.env, aiObserver),
        telemetry,
        measurerOf: (pair) => editMeasurer(pair),
        saveReport,
      },
    );
  } finally {
    await telemetry.shutdown();
    await aiObserver.shutdown();
  }
}

const curator = (command: Extract<EvalCommand, { kind: "curator" }>) =>
  curatorAt([command.label], command);
const compare = (command: Extract<EvalCommand, { kind: "compare" }>) =>
  curatorAt([DEFAULT_LABEL, command.label], command);

async function snapshot(command: Extract<EvalCommand, { kind: "snapshot" }>): Promise<void> {
  const { posthog, sources } = wiring();
  await refreshDataset(
    { datasetId: OWNER_REELS_DATASET, dryRun: command.dryRun, reel: command.reel, force: true },
    { posthog, sources },
  );
}

try {
  await runEvalCommand(process.argv.slice(2), {
    help: () => console.log(EVAL_USAGE),
    judge,
    curator,
    compare,
    snapshot,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
