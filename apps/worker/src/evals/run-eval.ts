import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AI_MODELS, type AiRunner, NO_USAGE } from "../ai.ts";
import { type PromptSource, promptIdentity } from "../prompts/source.ts";
import { addUsage } from "../step-store.ts";
import { type Telemetry, inSpan } from "../telemetry.ts";
import { type CuratorRun, type RunSources, curatorRunsFor, runCandidates } from "./curator-runs.ts";
import { JUDGE_PROMPT_NAME, type Verdict, callJudge } from "./judge-call.ts";
import {
  type JudgePick,
  type SentPick,
  type Why,
  judgePicks,
  labelPick,
  sentPick,
  wordsOf,
} from "./label.ts";
import { type OwnerItem, parseOwnerItem } from "./owner-marks.ts";
import type { EvalsApi, UploadBody } from "./posthog-evals.ts";
import { percent, renderReport } from "./report.ts";
import { type JudgedPick, agreement, score, tally } from "./score.ts";

// THE JUDGE EVAL (app_docs/evals.md): how well the components judge agrees
// with the owner's hand labels, measured on picks the curator already made.
// It reads the dataset, the stored curator runs and the judge prompt, calls
// the judge once per reel and curator run, and uploads the run to PostHog as
// an offline experiment. It never calls the curator and writes nothing to the
// database or to storage.

const SCORER = "judge_agreement";
const SCORER_DESCRIPTION =
  "Share of picks where the components judge's verdict matches the owner's label (approve for good, reject for bad), 0 to 1 per labelled reel.";
const SUITE = "components-judge";
// The shuffle's fixed seed: the same run always shows the judge the same order.
const SEED = "components-judge-1";

export interface EvalOptions {
  datasetId: string;
  // Everything but the judge calls and the upload: only the counts are printed.
  dryRun: boolean;
  // Only the labelled reel whose id starts like this.
  reel?: string;
}

export interface EvalDeps {
  posthog: EvalsApi;
  sources: RunSources;
  prompts: PromptSource;
  ai: AiRunner;
  telemetry: Telemetry;
  // Writes the report under the gitignored output folder; resolves with its path.
  saveReport: (fileName: string, html: string) => Promise<string>;
  log?: (line: string) => void;
  now?: () => Date;
  newId?: () => string;
}

// What one labelled reel holds before any judge call.
export interface ReelCounts {
  reel: string;
  curatorRuns: number;
  // Runs of the reel itself decided from another transcript (not usable).
  differingRuns: number;
  ownerMarks: number;
  curatorPicks: number;
  good: number;
  bad: number;
  why: Partial<Record<Why, number>>;
  // The picks the judge would see over all the reel's calls, after merging.
  judgePicks: number;
}

export interface EvalSummary {
  reels: ReelCounts[];
  // Absent on a dry run.
  experimentId?: string;
  agreement?: number | null;
  reportPath?: string;
}

interface PreparedCall {
  run: CuratorRun;
  picks: JudgePick[];
  sent: SentPick[];
}

interface Prepared {
  item: OwnerItem;
  calls: PreparedCall[];
  counts: ReelCounts;
}

function runName(run: CuratorRun): string {
  return `${run.reelId.slice(0, 8)} v${run.number} ${run.promptVersion}`;
}

function countsLines({ counts, calls }: Prepared): string[] {
  const why = Object.entries(counts.why)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  return [
    `reel ${counts.reel}: ${counts.curatorRuns} curator runs, ${counts.ownerMarks} owner marks, ${counts.curatorPicks} curator picks (${counts.good} good, ${counts.bad} bad${why ? `: ${why}` : ""}), ${counts.judgePicks} judge picks` +
      (counts.differingRuns > 0
        ? `; ${counts.differingRuns} runs of this reel left out (another transcript)`
        : ""),
    ...calls.map(
      ({ run, picks }) =>
        `  ${runName(run)}: ${run.picks.length} picks, ${picks.length} judge picks` +
        (run.unreadable > 0 ? `, ${run.unreadable} unreadable` : ""),
    ),
  ];
}

async function prepare(
  item: OwnerItem,
  deps: EvalDeps,
  candidates: Awaited<ReturnType<typeof runCandidates>>,
): Promise<Prepared> {
  const found = await curatorRunsFor(item, candidates, deps.sources.readJson);
  const why: Partial<Record<Why, number>> = {};
  let good = 0;
  let bad = 0;
  for (const run of found.runs) {
    for (const pick of run.picks) {
      const labelled = labelPick(pick, item.marks, item.nothing);
      if (labelled.label === "good") good += 1;
      else {
        bad += 1;
        why[labelled.why] = (why[labelled.why] ?? 0) + 1;
      }
    }
  }
  const calls = found.runs.map((run) => {
    const picks = judgePicks(run.picks, item, `${SEED}/${item.reelId}/${run.versionId}`);
    return { run, picks, sent: picks.map((pick) => sentPick(pick, item.words)) };
  });
  return {
    item,
    calls,
    counts: {
      reel: item.reelId,
      curatorRuns: found.runs.length,
      differingRuns: found.differing,
      ownerMarks: item.marks.length,
      curatorPicks: good + bad,
      good,
      bad,
      why,
      judgePicks: calls.reduce((sum, call) => sum + call.picks.length, 0),
    },
  };
}

// One judged call: its verdicts joined to the picks, or why it has none.
type Judged =
  | { call: PreparedCall; ok: true; verdicts: Verdict[]; picks: JudgedPick[] }
  | { call: PreparedCall; ok: false; reasons: string[] };

function judged(item: OwnerItem, call: PreparedCall, verdicts: readonly Verdict[]): JudgedPick[] {
  const byId = new Map(verdicts.map((verdict) => [verdict.pick, verdict]));
  return call.picks.map((pick) => {
    const verdict = byId.get(pick.id)!;
    return {
      reel: item.reelId,
      run: runName(call.run),
      id: pick.id,
      component: pick.component,
      words: wordsOf(item.words, pick.span),
      label: pick.label,
      why: pick.why,
      sources: pick.sources,
      verdict: verdict.verdict,
      reason: verdict.reason,
      better: verdict.better,
    };
  });
}

// The upload of one run: one experiment item per labelled reel (pinned to the
// dataset item's version), one `judge_agreement` result each. A reel with no
// stored curator run is `skipped`; one whose every judge call stayed invalid
// is an `error`; any other is `ok` with its agreement over the calls that
// answered.
function uploadBody({
  results,
  scorerVersionId,
  traceId,
  evaluatedAt,
  judgePrompt,
  judgeLabel,
  newId,
}: {
  results: readonly { item: OwnerItem; judged: readonly Judged[] }[];
  scorerVersionId: string;
  traceId: string;
  evaluatedAt: string;
  judgePrompt: string;
  judgeLabel: string;
  newId: () => string;
}): UploadBody {
  const body: UploadBody = { items: [], results: [] };
  for (const { item, judged: calls } of results) {
    const id = newId();
    const run = (call: PreparedCall) => ({
      curator_reel_id: call.run.reelId,
      curator_version_id: call.run.versionId,
      curator_prompt_version: call.run.promptVersion,
    });
    const curatorPrompts = [...new Set(calls.map(({ call }) => call.run.promptVersion))].sort();
    const metadata = {
      reel_id: item.reelId,
      judge_prompt_version: judgePrompt,
      judge_prompt_label: judgeLabel,
      judge_model: AI_MODELS.judge,
      curator_prompt_versions: curatorPrompts,
    };
    body.items.push({
      id,
      case_key: item.caseKey,
      dataset_item_version_id: item.versionId,
      payload: {
        input: { runs: calls.map(({ call }) => ({ ...run(call), picks: call.sent })) },
        output: {
          runs: calls.map((one) => ({
            ...run(one.call),
            ...(one.ok ? { verdicts: one.verdicts } : { error: one.reasons }),
          })),
        },
        expected_output: {
          runs: calls.map(({ call }) => ({
            ...run(call),
            labels: call.picks.map(({ id: pick, label, why }) => ({ pick, label, why })),
          })),
        },
        metadata,
      },
    });
    const answered = calls.filter((one) => one.ok).length;
    const of = tally(calls.flatMap((one) => (one.ok ? one.picks : [])));
    const shared = {
      item_id: id,
      scorer_version_id: scorerVersionId,
      evaluator_trace_id: traceId,
      evaluated_at: evaluatedAt,
    };
    const details = {
      ...metadata,
      ...of,
      curator_runs: calls.length,
      runs: calls.map((one) => ({
        ...run(one.call),
        agreement: one.ok ? agreement(tally(one.picks)) : null,
      })),
    };
    const value = agreement(of);
    if (calls.length === 0) {
      body.results.push({
        ...shared,
        status: "skipped",
        payload: { reasoning: "no stored curator run for this reel", metadata: details },
      });
    } else if (value === null) {
      body.results.push({
        ...shared,
        status: "error",
        error_code: "judge_answer_invalid",
        payload: {
          error_message: calls.flatMap((one) => (one.ok ? [] : one.reasons)).join("; "),
          metadata: details,
        },
      });
    } else {
      body.results.push({
        ...shared,
        status: "ok",
        value,
        payload: {
          reasoning: `the judge agrees with the owner's label on ${of.agree} of ${of.total} picks over ${answered} of ${calls.length} curator runs`,
          metadata: details,
        },
      });
    }
  }
  return body;
}

export async function runJudgeEval(options: EvalOptions, deps: EvalDeps): Promise<EvalSummary> {
  const { posthog, telemetry } = deps;
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const startedAt = now().toISOString();

  const dataset = await posthog.dataset(options.datasetId);
  const items = dataset.items
    .map(parseOwnerItem)
    .filter(
      (item) =>
        !options.reel ||
        item.reelId.startsWith(options.reel) ||
        options.reel.startsWith(item.reelId),
    );
  if (items.length === 0) {
    throw new Error(
      options.reel
        ? `evals: no labelled reel ${options.reel} in the dataset`
        : "evals: the dataset has no item",
    );
  }
  log(`dataset revision ${dataset.revision}: ${items.length} labelled reels`);
  const candidates = await runCandidates(deps.sources);
  const prepared: Prepared[] = [];
  for (const item of items) {
    const one = await prepare(item, deps, candidates);
    for (const line of countsLines(one)) log(line);
    prepared.push(one);
  }
  const reels = prepared.map((one) => one.counts);
  const sum = (field: "curatorRuns" | "curatorPicks" | "good" | "bad" | "judgePicks") =>
    reels.reduce((total, counts) => total + counts[field], 0);
  log(
    `total: ${sum("curatorRuns")} judge calls, ${sum("curatorPicks")} curator picks (${sum("good")} good, ${sum("bad")} bad), ${sum("judgePicks")} judge picks`,
  );
  if (options.dryRun) {
    log("dry run: no judge call, no upload");
    return { reels };
  }

  // Before any paid call: the prompt, the scorer and the experiment, so a
  // missing prompt or key scope costs nothing.
  const template = await deps.prompts.get(JUDGE_PROMPT_NAME);
  const judgePrompt = promptIdentity(template);
  const curatorPrompts = [
    ...new Set(prepared.flatMap((one) => one.calls.map((call) => call.run.promptVersion))),
  ].sort();
  const scorerVersionId = await posthog.scorerVersion(SCORER, SCORER_DESCRIPTION);
  const experimentId = newId();
  const traceId = experimentId.replaceAll("-", "");
  await posthog.createExperiment({
    id: experimentId,
    name: `components judge ${judgePrompt} (${template.label}) ${startedAt}`,
    started_at: startedAt,
    run_source: "local",
    suite_key: SUITE,
    dataset_revision_id: dataset.revisionId,
    expected_item_count: prepared.length,
    expected_result_count: prepared.length,
    model_version: AI_MODELS.judge,
    prompt_version: judgePrompt,
    application_version: curatorPrompts.join(", ").slice(0, 255) || "none",
  });
  log(`experiment ${experimentId}, judge ${judgePrompt} (label ${template.label})`);

  try {
    const root = telemetry.startRootSpan(traceId, "eval.judge", {
      attributes: {
        "eval.experiment_id": experimentId,
        "eval.suite": SUITE,
        "edit_issebya.ai.prompt_version": judgePrompt,
      },
    });
    const rootContext = trace.setSpan(ROOT_CONTEXT, root);
    let usage = NO_USAGE;
    const results: { item: OwnerItem; judged: Judged[] }[] = [];
    try {
      for (const { item, calls } of prepared) {
        const done: Judged[] = [];
        for (const call of calls) {
          const outcome = await inSpan(
            telemetry,
            rootContext,
            "eval.judge.call",
            {
              "reel.id": call.run.reelId,
              "eval.case": item.caseKey,
              "eval.curator_version_id": call.run.versionId,
              "eval.curator_prompt_version": call.run.promptVersion,
            },
            (_span, context) =>
              callJudge({
                ai: deps.ai,
                template,
                transcript: call.run.transcript,
                picks: call.sent,
                trace: { telemetry, parent: context },
              }),
          );
          usage = addUsage(usage, outcome.usage);
          if (outcome.ok) {
            const picks = judged(item, call, outcome.verdicts);
            done.push({ call, ok: true, verdicts: outcome.verdicts, picks });
            log(`  ${runName(call.run)}: agreement ${percent(agreement(tally(picks)))}`);
          } else {
            done.push({ call, ok: false, reasons: outcome.reasons });
            log(`  ${runName(call.run)}: no valid answer: ${outcome.reasons.join("; ")}`);
          }
        }
        results.push({ item, judged: done });
      }
    } finally {
      root.end();
    }

    const picks = results.flatMap(({ judged: calls }) =>
      calls.flatMap((one) => (one.ok ? one.picks : [])),
    );
    const failures = results.flatMap(({ item, judged: calls }) =>
      calls.flatMap((one) =>
        one.ok ? [] : [{ reel: item.reelId, run: runName(one.call.run), reasons: one.reasons }],
      ),
    );
    const scored = score(picks);
    const reportPath = await deps.saveReport(
      `judge-${startedAt.replaceAll(":", "-")}.html`,
      renderReport({
        startedAt,
        judgePrompt,
        judgeLabel: template.label,
        model: AI_MODELS.judge,
        datasetRevision: dataset.revision,
        curatorPrompts,
        experimentId,
        picks,
        failures,
      }),
    );
    log(
      `agreement ${percent(agreement(scored.overall))} (${scored.overall.agree} of ${scored.overall.total} picks); approve/bad ${scored.overall.approveBad}, reject/good ${scored.overall.rejectGood}`,
    );
    for (const { component, tally: of } of scored.byComponent) {
      log(`  ${component}: ${percent(agreement(of))} (${of.agree} of ${of.total})`);
    }
    if (usage.costUsd !== null) log(`judge cost: $${usage.costUsd.toFixed(4)}`);
    log(`report: ${reportPath}`);

    await posthog.upload(
      experimentId,
      uploadBody({
        results,
        scorerVersionId,
        traceId,
        evaluatedAt: now().toISOString(),
        judgePrompt,
        judgeLabel: template.label,
        newId,
      }),
    );
    await posthog.complete(experimentId);
    log(`uploaded to PostHog: offline experiment ${experimentId}`);
    return { reels, experimentId, agreement: agreement(scored.overall), reportPath };
  } catch (error) {
    // The experiment exists: close it as failed, then report the real error.
    await posthog.fail(experimentId).catch(() => undefined);
    throw error;
  }
}
