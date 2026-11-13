// `yarn workspace @edit-issebya/worker eval:curator [--dry-run] [--reel <id>] [--repeats <n>]
//   [--curator-label <label> | --curator-prompt-file <path>]
//   [--judge-label <label> | --judge-prompt-file <path>]`: the components curator
// run on the owner's hand-labelled reels, scored against the marks, the picks
// judged (app_docs/evals.md, "The curator eval"). It reads the dataset items
// only (run `eval:snapshot` first); its writes are the AI calls, the report file
// and the PostHog experiment.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { aiRunner } from "./ai.ts";
import { posthogEvals } from "./evals/posthog-evals.ts";
import { runCuratorEval } from "./evals/run-curator.ts";
import { checkPromptSource, readDraftPrompt } from "./evals/draft-prompt.ts";
import { posthogPromptSource } from "./prompts/posthog-source.ts";
import { editMeasurer } from "./edit-measurer.ts";
import { createTelemetry } from "./telemetry.ts";

// The PostHog dataset `owner-reels`: the reels the owner labelled by hand.
const OWNER_REELS_DATASET = "01a1cf52-f6c3-7182-a7d9-5681010286ce";
// Where reports go: `apps/worker/eval-output/`, gitignored.
const OUTPUT_DIR = fileURLToPath(new URL("../eval-output/", import.meta.url));
// The repository's root: a draft prompt may not be read from inside it.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_LABEL = "production";
const MAX_REPEATS = 20;

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    reel: { type: "string" },
    repeats: { type: "string" },
    "curator-label": { type: "string" },
    "curator-prompt-file": { type: "string" },
    "judge-label": { type: "string" },
    "judge-prompt-file": { type: "string" },
  },
});

function repeatsOf(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEATS) {
    throw new Error(`evals: --repeats must be a whole number from 1 to ${MAX_REPEATS}`);
  }
  return count;
}

// `<name>` from PostHog at its label: each side has its own label, so the
// curator and the judge can be fetched at different labels.
function envAt(label: string | undefined): NodeJS.ProcessEnv {
  return { ...process.env, POSTHOG_PROMPT_LABEL: label ?? DEFAULT_LABEL };
}

async function draftOf(path: string | undefined) {
  if (path === undefined) return undefined;
  return readDraftPrompt({
    path,
    repoRoot: REPO_ROOT,
    /* eslint-disable-next-line security/detect-non-literal-fs-filename -- the draft the owner named, outside the repository */
    read: (file) => readFile(file, "utf8"),
  });
}

const telemetry = createTelemetry();

try {
  checkPromptSource({ label: values["curator-label"], promptFile: values["curator-prompt-file"] });
  checkPromptSource({ label: values["judge-label"], promptFile: values["judge-prompt-file"] });
  const repeats = repeatsOf(values.repeats);
  const curatorDraft = await draftOf(values["curator-prompt-file"]);
  const judgeDraft = await draftOf(values["judge-prompt-file"]);
  await runCuratorEval(
    {
      datasetId: OWNER_REELS_DATASET,
      dryRun: values["dry-run"],
      reel: values.reel,
      repeats,
      ...(curatorDraft ? { curatorDraft } : {}),
      ...(judgeDraft ? { judgeDraft } : {}),
    },
    {
      posthog: posthogEvals(process.env),
      curatorPrompts: posthogPromptSource(envAt(values["curator-label"])),
      judgePrompts: posthogPromptSource(envAt(values["judge-label"])),
      ai: aiRunner(process.env),
      telemetry,
      measurerOf: (pair) => editMeasurer(pair),
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
