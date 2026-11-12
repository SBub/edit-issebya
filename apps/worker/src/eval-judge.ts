// `yarn workspace @edit-issebya/worker eval:judge [--dry-run] [--reel <id>] [--label <label> | --prompt-file <path>]`:
// the components judge against the owner's hand-labelled reels
// (app_docs/evals.md). Read-only on the database and on storage; its only
// writes are the judge calls, the report file and the PostHog experiment.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { aiRunner } from "./ai.ts";
import { workerConfig } from "./config.ts";
import { posthogEvals } from "./evals/posthog-evals.ts";
import { runJudgeEval } from "./evals/run-eval.ts";
import { workerRunSources } from "./evals/worker-sources.ts";
import { posthogPromptSource } from "./prompts/posthog-source.ts";
import { checkPromptSource, readDraftPrompt } from "./evals/draft-prompt.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";
import { createTelemetry } from "./telemetry.ts";

// The PostHog dataset `owner-reels`: the reels the owner labelled by hand.
const OWNER_REELS_DATASET = "01a1cf52-f6c3-7182-a7d9-5681010286ce";
// Where reports go: `apps/worker/eval-output/`, gitignored.
const OUTPUT_DIR = fileURLToPath(new URL("../eval-output/", import.meta.url));
// The repository's root: a draft prompt may not be read from inside it.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    reel: { type: "string" },
    label: { type: "string" },
    "prompt-file": { type: "string" },
  },
});

const config = workerConfig();
// `--label` picks the judge prompt's label; without it, POSTHOG_PROMPT_LABEL.
const env = { ...process.env, ...(values.label ? { POSTHOG_PROMPT_LABEL: values.label } : {}) };
const telemetry = createTelemetry();

try {
  checkPromptSource({ label: values.label, promptFile: values["prompt-file"] });
  // A draft judged from a local file outside the repository, instead of PostHog's prompt.
  const draft =
    values["prompt-file"] === undefined
      ? undefined
      : await readDraftPrompt({
          path: values["prompt-file"],
          repoRoot: REPO_ROOT,
          /* eslint-disable-next-line security/detect-non-literal-fs-filename -- the draft the owner named, outside the repository */
          read: (path) => readFile(path, "utf8"),
        });
  await runJudgeEval(
    { datasetId: OWNER_REELS_DATASET, dryRun: values["dry-run"], reel: values.reel, draft },
    {
      posthog: posthogEvals(env),
      sources: workerRunSources(workerSupabase(config), workerStorage(), config.keyPrefix),
      prompts: posthogPromptSource(env),
      ai: aiRunner(env),
      telemetry,
      async saveReport(fileName, html) {
        const path = `${OUTPUT_DIR}${fileName}`;
        /* eslint-disable security/detect-non-literal-fs-filename -- the eval's own output folder */
        await mkdir(OUTPUT_DIR, { recursive: true });
        await writeFile(path, html);
        /* eslint-enable security/detect-non-literal-fs-filename */
        return path;
      },
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await telemetry.shutdown();
}
