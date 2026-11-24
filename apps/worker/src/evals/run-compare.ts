import { type PromptSource, PromptUnavailable, promptIdentity } from "../prompts/source.ts";
import { renderTableText } from "./compare-table.ts";
import { CURATOR_PROMPT_NAME } from "./curator-call.ts";
import { renderCompareReport } from "./curator-report.ts";
import {
  type CuratorEvalDeps,
  type CuratorEvalOptions,
  type CuratorEvalSummary,
  runCuratorEval,
} from "./run-curator.ts";

// THE COMPARISON (app_docs/evals.md, "The comparison table"): the curator eval
// run once per prompt label, one after the other (parallel runs hit a PostHog
// 409), all on the dataset revision read first and the same repeats, then one
// table of every prompt. The labels name versions of the `reel-components`
// prompt in PostHog: `production` first (the base), then the one under test.
export interface CompareOptions extends CuratorEvalOptions {
  labels: string[];
}

export type CompareDeps = Omit<CuratorEvalDeps, "curatorPrompts"> & {
  // The prompt source that serves the curator prompt at a label.
  promptsAt: (label: string) => PromptSource;
};

export interface CompareSummary {
  runs: CuratorEvalSummary[];
  reportPath?: string;
}

export async function runCuratorCompare(
  options: CompareOptions,
  deps: CompareDeps,
): Promise<CompareSummary> {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { labels, ...rest } = options;
  // One source per label, so the version read here is the version the run uses.
  const sources = new Map<string, PromptSource>();
  const sourceAt = (label: string): PromptSource => {
    const held = sources.get(label) ?? deps.promptsAt(label);
    sources.set(label, held);
    return held;
  };
  // Every prompt is fetched before any paid call: a missing label stops here.
  const versions: string[] = [];
  for (const [at, label] of labels.entries()) {
    try {
      const prompt = await sourceAt(label).get(CURATOR_PROMPT_NAME);
      versions.push(promptIdentity(prompt));
      log(`prompt ${label}: ${promptIdentity(prompt)}`);
    } catch (error) {
      // The base (first) is fetched first: when it answers, the prompt exists, so a 404
      // for a later label means no version carries that label.
      if (at > 0 && error instanceof PromptUnavailable && error.code === "not-found") {
        throw new Error(
          `evals: no version of ${CURATOR_PROMPT_NAME} has the label "${label}". Create it in PostHog: Prompts > ${CURATOR_PROMPT_NAME} > open the version to try > add the label "${label}".`,
        );
      }
      throw error;
    }
  }
  if (labels.length > 1 && new Set(versions).size === 1) {
    log(`note: ${labels.join(" and ")} are the same version (${versions[0]}): nothing to compare`);
  }
  // One read of the dataset: every prompt is measured on this revision.
  const dataset = await deps.posthog.dataset(options.datasetId);
  const pinned = { ...deps, posthog: { ...deps.posthog, dataset: async () => dataset } };
  const runs: CuratorEvalSummary[] = [];
  const summaries = () => runs.flatMap((run) => (run.summary ? [run.summary] : []));
  try {
    for (const [at, label] of labels.entries()) {
      if (labels.length > 1) log(`prompt ${at + 1} of ${labels.length}: ${label}`);
      runs.push(await runCuratorEval(rest, { ...pinned, curatorPrompts: sourceAt(label) }));
      // A dry run lists the counts once: they are the same for every prompt.
      if (options.dryRun) return { runs };
      // The row of each prompt as it finishes, so a later prompt's crash loses nothing.
      if (labels.length > 1) log(renderTableText(summaries()).at(-1)!);
    }
  } finally {
    // The table of every prompt that finished, even when a later one failed.
    if (!options.dryRun && runs.length > 0) {
      log("");
      log(
        `dataset revision ${dataset.revision}, ${options.repeats} ${options.repeats === 1 ? "run" : "runs"} per reel`,
      );
      for (const line of renderTableText(summaries())) log(line);
      const cost = runs.reduce((total, run) => total + (run.costUsd ?? 0), 0);
      log(`cost: $${cost.toFixed(4)}`);
    }
  }
  if (runs.length === 1) return { runs };
  const reportPath = await deps.saveReport(
    `curator-compare-${startedAt.replaceAll(":", "-")}.html`,
    renderCompareReport({
      startedAt,
      datasetRevision: dataset.revision,
      repeats: options.repeats,
      summaries: summaries(),
      reports: runs.flatMap((run) => (run.reportPath ? [run.reportPath] : [])),
    }),
  );
  log(`comparison report: ${reportPath}`);
  return { runs, reportPath };
}
