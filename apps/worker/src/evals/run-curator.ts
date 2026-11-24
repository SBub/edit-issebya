import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { ISSEBYA_PRESET, type Measurer, type Preset } from "@edit-issebya/edit";
import { AI_MODELS, type AiRunner, NO_USAGE } from "../ai.ts";
import { withAiContext } from "../ai-observability.ts";
import { type PromptSource, promptIdentity } from "../prompts/source.ts";
import { addUsage } from "../step-store.ts";
import { type Telemetry, inSpan } from "../telemetry.ts";
import type { TracedAnswer } from "../decision-trace.ts";
import { picksOfAnswer } from "./curator-runs.ts";
import { type CuratorCase, type ParseCurrent, curatorCaseOf } from "./curator-input.ts";
import { curatorInputOf, missingSnapshot } from "./snapshot-format.ts";
import {
  CURATOR_PROMPT_NAME,
  type MeasurerOf,
  type Validate,
  callCurator,
  decideValidator,
} from "./curator-call.ts";
import { type Label, type Why, labelPick, wordsOf } from "./label.ts";
import {
  type Component,
  type ComponentPick,
  type OwnerItem,
  selectOwnerItems,
} from "./owner-marks.ts";
import type { Dataset, EvalsApi, UploadBody } from "./posthog-evals.ts";
import { type CuratorReport, renderCuratorReport } from "./curator-report.ts";
import { COLUMNS, type ColumnKey, type RunScore, prf, scoreRun, sumRuns } from "./curator-score.ts";
import { type PromptSummary, type ScoredRun, summarizePrompt } from "./compare-table.ts";

// THE CURATOR EVAL (app_docs/evals.md, "The curator eval"): the components
// prompt run on each labelled reel of the dataset, its picks scored against
// the owner's marks by code. The judge is not part of it (it has its own eval).
// It reads the dataset items only (their curator input, written by
// the refresh step) and writes the AI calls, the report file and the PostHog
// experiment. It reads nothing from the database or from storage.

// One scorer per column of the comparison table (`COLUMNS`).
const SUITE = "components-curator";
// Every upload of this scoring carries it as the experiment's application
// version, so the experiments made before it are told apart in PostHog.
// Change it when what a score means changes.
export const SCORING_VERSION = "scoring-2026-11-24";

export interface CuratorEvalOptions {
  datasetId: string;
  dryRun: boolean;
  reel?: string;
  // Curator calls per reel.
  repeats: number;
}

export interface CuratorEvalDeps {
  posthog: EvalsApi;
  // The curator's prompt source (at the label under test).
  curatorPrompts: PromptSource;
  ai: AiRunner;
  telemetry: Telemetry;
  measurerOf: MeasurerOf;
  saveReport: (fileName: string, html: string) => Promise<string>;
  preset?: Preset;
  parseCurrent?: ParseCurrent;
  // The check of an answer's placement; the default is the decide step's.
  validatorOf?: (current: CuratorCase, measure: Measurer) => Validate;
  log?: (line: string) => void;
  now?: () => Date;
  newId?: () => string;
}

export interface CuratorEvalSummary {
  // Labelled reels that have a case, and those skipped with the reason.
  built: number;
  skipped: { reel: string; reason: string }[];
  // Absent on a dry run.
  experimentId?: string;
  // The dataset revision the run read, and the prompt's row of the comparison table.
  datasetRevision?: number;
  summary?: PromptSummary;
  reportPath?: string;
  costUsd?: number;
}

// One curator call of a case: the picks it answered, labelled.
interface ReportPick {
  component: Component;
  words: string;
  label: Label;
  why: Why;
}

interface RunRecord {
  repeat: number;
  // Why the answer was refused twice (no picks then).
  failed?: string[];
  picks: ReportPick[];
  // A run with no valid answer scores as an answer with no picks.
  score: RunScore;
}

interface CaseResult {
  built: CuratorCase;
  runs: RunRecord[];
  score: RunScore;
}

// The runs of a case as the comparison table reads them.
function scoredRuns(result: CaseResult): ScoredRun[] {
  return result.runs.map((run) => ({
    repeat: run.repeat,
    ok: !run.failed,
    score: run.score,
  }));
}

function pickWords(pick: ComponentPick, words: OwnerItem["words"]): string {
  return pick.items
    ? pick.items.map((item) => wordsOf(words, item)).join(" / ")
    : wordsOf(words, pick.span);
}

function curatorUploadBody({
  results,
  scorers,
  traceId,
  evaluatedAt,
  curator,
  repeats,
  newId,
}: {
  results: readonly CaseResult[];
  scorers: Record<ColumnKey, string>;
  traceId: string;
  evaluatedAt: string;
  curator: { id: string; label: string };
  repeats: number;
  newId: () => string;
}): UploadBody {
  const body: UploadBody = { items: [], results: [] };
  for (const result of results) {
    const { built } = result;
    const id = newId();
    const failedRuns = result.runs.filter((run) => run.failed);
    const curatorRuns = result.runs.filter((run) => !run.failed).length;
    const metadata = {
      reel_id: built.reelId,
      version_id: built.versionId,
      version_number: built.versionNumber,
      curator_prompt_version: curator.id,
      curator_prompt_label: curator.label,
      curator_model: AI_MODELS.decide,
      scoring: SCORING_VERSION,
      repeats,
      curator_runs_ok: curatorRuns,
      curator_runs_failed: failedRuns.length,
      notes: built.notes,
    };
    body.items.push({
      id,
      case_key: built.item.caseKey,
      dataset_item_version_id: built.item.versionId,
      payload: {
        input: {
          script: built.input.script,
          hook: built.hook,
          intensity: built.input.intensity,
          target_picks: built.input.target_picks,
        },
        output: {
          runs: result.runs.map((run) => ({
            repeat: run.repeat,
            ...(run.failed ? { error: run.failed } : {}),
            picks: run.picks,
          })),
        },
        expected_output: {
          marks: built.item.marks.map((mark) => ({
            component: mark.component,
            words: pickWords(mark, built.item.words),
          })),
        },
        metadata,
      },
    });
    const shared = { item_id: id, evaluator_trace_id: traceId, evaluated_at: evaluatedAt };
    for (const column of COLUMNS) {
      const key = column.key;
      const counts = column.counts(result.score);
      const f1 = prf(counts).f1;
      const scorer = scorers[key];
      if (curatorRuns === 0) {
        body.results.push({
          ...shared,
          scorer_version_id: scorer,
          status: "error",
          error_code: "curator_answer_invalid",
          payload: {
            error_message: failedRuns.flatMap((run) => run.failed ?? []).join("; "),
            metadata: { ...metadata, counts },
          },
        });
      } else if (f1 === null) {
        body.results.push({
          ...shared,
          scorer_version_id: scorer,
          status: "skipped",
          payload: { reasoning: `no curator pick and no owner mark for ${key}`, metadata },
        });
      } else {
        body.results.push({
          ...shared,
          scorer_version_id: scorer,
          status: "ok",
          value: f1,
          payload: {
            reasoning: `${key} F1 ${f1.toFixed(3)} over ${curatorRuns} of ${result.runs.length} curator runs (a failed run counts as no picks): ${counts.good} of ${counts.picks} picks good, ${counts.matched} of ${counts.marks} owner marks matched`,
            metadata: { ...metadata, counts },
          },
        });
      }
    }
  }
  return body;
}

export async function runCuratorEval(
  options: CuratorEvalOptions,
  deps: CuratorEvalDeps,
): Promise<CuratorEvalSummary> {
  const { posthog, telemetry } = deps;
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const preset = deps.preset ?? ISSEBYA_PRESET;
  const startedAt = now().toISOString();

  const dataset: Dataset = await posthog.dataset(options.datasetId);
  const items = selectOwnerItems(dataset.items, options.reel);
  log(`dataset revision ${dataset.revision}: ${items.length} labelled reels`);

  // Every item's snapshot is checked before any case is built or call made.
  const stored = items.map((item) => {
    const input = curatorInputOf(item.raw, item.id);
    if (input === null) throw missingSnapshot(item.id, "input.curator_input");
    return input;
  });
  const cases: CuratorCase[] = [];
  const skipped: { reel: string; reason: string }[] = [];
  for (const [at, item] of items.entries()) {
    const built = curatorCaseOf({
      item,
      stored: stored[at]!,
      preset,
      ...(deps.parseCurrent ? { parseCurrent: deps.parseCurrent } : {}),
    });
    if (!built.ok) {
      skipped.push({ reel: item.reelId, reason: built.reason });
      log(`reel ${item.reelId}: skipped: ${built.reason}`);
      continue;
    }
    const c = built.case;
    cases.push(c);
    const words = c.transcript.words.length;
    log(
      `reel ${c.reelId} v${c.versionNumber}: ${c.input.script.length} sentences, ${words} words, hook from ${c.hook.source} (${c.hook.text.length} characters), intensity ${c.input.intensity}, target ${c.input.target_picks} picks, ${options.repeats} curator ${options.repeats === 1 ? "call" : "calls"}`,
    );
    for (const note of c.notes) log(`  note: ${note}`);
  }
  log(
    `total: ${cases.length} reels with a curator input, ${skipped.length} skipped, ${cases.length * options.repeats} curator calls`,
  );
  if (options.dryRun) {
    log("dry run: no AI call, no upload");
    return { built: cases.length, skipped };
  }

  // Before any paid call: the prompt, the scorers and the experiment, so a
  // missing prompt or key scope costs nothing.
  const curatorTemplate = await deps.curatorPrompts.get(CURATOR_PROMPT_NAME);
  const curator = { id: promptIdentity(curatorTemplate), label: curatorTemplate.label };
  const scorers = {} as Record<ColumnKey, string>;
  for (const column of COLUMNS) {
    scorers[column.key] = await posthog.scorerVersion(column.scorer, column.description);
  }
  const experimentId = newId();
  const traceId = experimentId.replaceAll("-", "");
  await posthog.createExperiment({
    id: experimentId,
    name: `components curator ${curator.id} (${curator.label}) ${startedAt}`,
    started_at: startedAt,
    run_source: "local",
    suite_key: SUITE,
    dataset_revision_id: dataset.revisionId,
    expected_item_count: cases.length,
    expected_result_count: cases.length * COLUMNS.length,
    model_version: AI_MODELS.decide,
    prompt_version: curator.id,
    application_version: SCORING_VERSION,
  });
  log(`experiment ${experimentId}, curator ${curator.id} (${curator.label})`);

  try {
    const root = telemetry.startRootSpan(traceId, "eval.curator", {
      attributes: {
        "eval.experiment_id": experimentId,
        "eval.suite": SUITE,
        "edit_issebya.ai.prompt_version": curator.id,
      },
    });
    const rootContext = trace.setSpan(ROOT_CONTEXT, root);
    const results: CaseResult[] = [];
    let usage = NO_USAGE;
    // Every call's generation event names this run (the experiment) as its trace.
    const aiFor = (c: CuratorCase) =>
      withAiContext(deps.ai, {
        traceId: experimentId,
        reelId: c.reelId,
        properties: { source: "eval:curator", eval_suite: SUITE, eval_case: c.item.caseKey },
      });
    try {
      for (const c of cases) {
        const measure = await deps.measurerOf(c.current.font_pair);
        const validate = deps.validatorOf
          ? deps.validatorOf(c, measure)
          : decideValidator({
              current: c.current,
              hookText: c.hook.text,
              preset,
              transcript: c.transcript,
              headTrack: c.headTrack,
              measure,
            });
        const runs: RunRecord[] = [];
        for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
          const outcome = await inSpan(
            telemetry,
            rootContext,
            "eval.curator.call",
            { "reel.id": c.reelId, "eval.case": c.item.caseKey, "eval.repeat": repeat },
            (_span, context) =>
              callCurator({
                ai: aiFor(c),
                template: curatorTemplate,
                input: c.input,
                preset,
                transcript: c.transcript,
                validate,
                trace: { telemetry, parent: context },
              }),
          );
          usage = addUsage(usage, outcome.usage);
          if (!outcome.ok) {
            runs.push({
              repeat,
              picks: [],
              failed: outcome.reasons,
              score: scoreRun([], c.item.marks),
            });
            log(`  ${c.reelId} run ${repeat}: no valid answer: ${outcome.reasons.join("; ")}`);
            continue;
          }
          const { picks } = picksOfAnswer(outcome.answer as TracedAnswer, c.transcript);
          const labelled = picks.map((pick) => ({
            pick,
            label: labelPick(pick, c.item.marks, c.item.nothing),
          }));
          const score = scoreRun(labelled, c.item.marks);
          runs.push({
            repeat,
            score,
            picks: labelled.map(({ pick, label }) => ({
              component: pick.component,
              words: pickWords(pick, c.item.words),
              label: label.label,
              why: label.why,
            })),
          });
          log(
            `  ${c.reelId} run ${repeat}: ${picks.length} picks, ${score.overall.good} good, ${score.overall.matched} of ${score.overall.marks} marks matched, F1 ${String(prf(score.overall).f1?.toFixed(3) ?? "n/a")}`,
          );
        }
        results.push({ built: c, runs, score: sumRuns(runs.map((run) => run.score)) });
      }
    } finally {
      root.end();
    }

    const overall = sumRuns(results.map((result) => result.score));
    const summary = summarizePrompt(curator, options.repeats, results.map(scoredRuns));
    const report: CuratorReport = {
      startedAt,
      curator,
      decideModel: AI_MODELS.decide,
      repeats: options.repeats,
      datasetRevision: dataset.revision,
      experimentId,
      summary,
      overall,
      cases: results.map((result) => ({
        reel: result.built.reelId,
        versionNumber: result.built.versionNumber,
        notes: result.built.notes,
        intensity: result.built.input.intensity,
        targetPicks: result.built.input.target_picks,
        marks: result.built.item.marks.map((mark) => ({
          component: mark.component,
          words: pickWords(mark, result.built.item.words),
        })),
        runs: result.runs,
        score: result.score,
      })),
      skipped,
    };
    const reportPath = await deps.saveReport(
      `curator-${startedAt.replaceAll(":", "-")}.html`,
      renderCuratorReport(report),
    );
    if (usage.costUsd !== null) log(`cost: $${usage.costUsd.toFixed(4)}`);
    log(`report: ${reportPath}`);

    await posthog.upload(
      experimentId,
      curatorUploadBody({
        results,
        scorers,
        traceId,
        evaluatedAt: now().toISOString(),
        curator,
        repeats: options.repeats,
        newId,
      }),
    );
    await posthog.complete(experimentId);
    log(`uploaded to PostHog: offline experiment ${experimentId}`);
    return {
      built: cases.length,
      skipped,
      experimentId,
      datasetRevision: dataset.revision,
      summary,
      reportPath,
      ...(usage.costUsd !== null ? { costUsd: usage.costUsd } : {}),
    };
  } catch (error) {
    // The experiment exists: close it as failed, then report the real error.
    await posthog.fail(experimentId).catch(() => undefined);
    throw error;
  }
}
