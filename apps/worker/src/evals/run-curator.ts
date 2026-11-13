import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { ISSEBYA_PRESET, type Measurer, type Preset } from "@edit-issebya/edit";
import { AI_MODELS, type AiRunner, NO_USAGE } from "../ai.ts";
import { type PromptSource, type PromptText, promptIdentity } from "../prompts/source.ts";
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
import { JUDGE_PROMPT_NAME, callJudge, type Verdict } from "./judge-call.ts";
import {
  type Label,
  type Labelled,
  type Why,
  judgePicks,
  labelPick,
  sentPick,
  wordsOf,
} from "./label.ts";
import {
  type Component,
  type ComponentPick,
  type OwnerItem,
  selectOwnerItems,
} from "./owner-marks.ts";
import { type DraftPrompt, draftId } from "./draft-prompt.ts";
import type { Dataset, EvalsApi, UploadBody } from "./posthog-evals.ts";
import { type CuratorReport, renderCuratorReport } from "./curator-report.ts";
import {
  type Approval,
  NO_APPROVAL,
  type RunScore,
  approvalRate,
  prf,
  scoreRun,
  sumRuns,
} from "./curator-score.ts";

// THE CURATOR EVAL (app_docs/evals.md, "The curator eval"): the components
// prompt run on each labelled reel of the dataset, its picks scored against
// the owner's marks by code, and each answer's picks judged in a separate call.
// It reads the dataset items only (their curator input, written by
// `eval:snapshot`) and writes the AI calls, the report file and the PostHog
// experiment. It reads nothing from the database or from storage.

const SCORERS = {
  f1: "curator_f1",
  approval: "judge_approval",
} as const;
const SCORER_DESCRIPTIONS = {
  [SCORERS.f1]:
    "F1 of the components curator's picks against the owner's labelled marks (accents, questions, big words, lists), 0 to 1 per labelled reel.",
  [SCORERS.approval]:
    "Share of the curator's picks the components judge approves, 0 to 1 per labelled reel.",
} as const;
const SUITE = "components-curator";
// The shuffle's fixed seed: the same run shows the judge the same order.
const SEED = "components-curator-1";

export interface CuratorEvalOptions {
  datasetId: string;
  dryRun: boolean;
  reel?: string;
  // Curator calls per reel.
  repeats: number;
  // Drafts read from local files, judged or curated in place of PostHog's prompt.
  curatorDraft?: DraftPrompt;
  judgeDraft?: DraftPrompt;
}

export interface CuratorEvalDeps {
  posthog: EvalsApi;
  // The curator's prompt source (its label) and the judge's (its label).
  curatorPrompts: PromptSource;
  judgePrompts: PromptSource;
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
  curatorF1?: number | null;
  judgeApproval?: number | null;
  reportPath?: string;
}

// One curator call of a case: the picks it answered, labelled, with the judge's verdicts.
interface ReportPick {
  component: Component;
  words: string;
  label: Label;
  why: Why;
  verdict: "approve" | "reject" | null;
}

interface RunRecord {
  repeat: number;
  // Why the answer was refused twice (no picks then).
  failed?: string[];
  picks: ReportPick[];
  score?: RunScore;
  // The judge's answer on this run's picks, or why it gave none.
  judge?: { judged: number; approved: number } | { failed: string[] } | null;
}

interface CaseResult {
  built: CuratorCase;
  runs: RunRecord[];
  score: RunScore;
  approval: Approval;
  judgeFailed: number;
}

// The identity of a pick across the labels and the judge's merged picks.
function keyOf(pick: {
  component: string;
  span: { from: number; to: number };
  items?: { from: number; to: number }[];
}): string {
  const items = (pick.items ?? []).map((item) => `${item.from}-${item.to}`).join(",");
  return `${pick.component}:${pick.span.from}-${pick.span.to}:${items}`;
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
  judge,
  repeats,
  newId,
}: {
  results: readonly CaseResult[];
  scorers: Record<keyof typeof SCORERS, string>;
  traceId: string;
  evaluatedAt: string;
  curator: { id: string; label: string; file?: string };
  judge: { id: string; label: string; file?: string };
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
      ...(curator.file ? { curator_prompt_file: curator.file } : {}),
      judge_prompt_version: judge.id,
      judge_prompt_label: judge.label,
      ...(judge.file ? { judge_prompt_file: judge.file } : {}),
      curator_model: AI_MODELS.decide,
      judge_model: AI_MODELS.judge,
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
            judge: run.judge ?? null,
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
    const f1 = prf(result.score.overall).f1;
    if (curatorRuns === 0) {
      body.results.push({
        ...shared,
        scorer_version_id: scorers.f1,
        status: "error",
        error_code: "curator_answer_invalid",
        payload: {
          error_message: failedRuns.flatMap((run) => run.failed ?? []).join("; "),
          metadata: { ...metadata, overall: result.score.overall },
        },
      });
    } else if (f1 === null) {
      body.results.push({
        ...shared,
        scorer_version_id: scorers.f1,
        status: "skipped",
        payload: { reasoning: "no curator pick and no owner mark", metadata },
      });
    } else {
      body.results.push({
        ...shared,
        scorer_version_id: scorers.f1,
        status: "ok",
        value: f1,
        payload: {
          reasoning: `F1 ${f1.toFixed(3)} over ${curatorRuns} curator runs: ${result.score.overall.good} of ${result.score.overall.picks} picks good, ${result.score.overall.matched} of ${result.score.overall.marks} owner marks matched`,
          metadata: { ...metadata, overall: result.score.overall },
        },
      });
    }
    const rate = approvalRate(result.approval);
    if (result.judgeFailed > 0 && result.approval.judged === 0) {
      body.results.push({
        ...shared,
        scorer_version_id: scorers.approval,
        status: "error",
        error_code: "judge_answer_invalid",
        payload: { error_message: "the judge gave no valid answer on any run", metadata },
      });
    } else if (rate === null) {
      body.results.push({
        ...shared,
        scorer_version_id: scorers.approval,
        status: "skipped",
        payload: { reasoning: "no curator pick to judge", metadata },
      });
    } else {
      body.results.push({
        ...shared,
        scorer_version_id: scorers.approval,
        status: "ok",
        value: rate,
        payload: {
          reasoning: `the judge approves ${result.approval.approved} of ${result.approval.judged} distinct picks over the curator runs`,
          metadata,
        },
      });
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
    `total: ${cases.length} reels with a curator input, ${skipped.length} skipped, ${cases.length * options.repeats} curator calls, at most as many judge calls (one per answer with picks)`,
  );
  if (options.dryRun) {
    log("dry run: no AI call, no upload");
    return { built: cases.length, skipped };
  }

  // Before any paid call: the prompts, the scorers and the experiment, so a
  // missing prompt or key scope costs nothing.
  const curatorTemplate: PromptText = options.curatorDraft
    ? { name: "draft", version: 0, label: "draft", text: options.curatorDraft.text }
    : await deps.curatorPrompts.get(CURATOR_PROMPT_NAME);
  const judgeTemplate: PromptText = options.judgeDraft
    ? { name: "draft", version: 0, label: "draft", text: options.judgeDraft.text }
    : await deps.judgePrompts.get(JUDGE_PROMPT_NAME);
  const curator = {
    id: options.curatorDraft ? draftId(options.curatorDraft.text) : promptIdentity(curatorTemplate),
    label: curatorTemplate.label,
    ...(options.curatorDraft ? { file: options.curatorDraft.file } : {}),
  };
  const judge = {
    id: options.judgeDraft ? draftId(options.judgeDraft.text) : promptIdentity(judgeTemplate),
    label: judgeTemplate.label,
    ...(options.judgeDraft ? { file: options.judgeDraft.file } : {}),
  };
  const scorers = {
    f1: await posthog.scorerVersion(SCORERS.f1, SCORER_DESCRIPTIONS[SCORERS.f1]),
    approval: await posthog.scorerVersion(SCORERS.approval, SCORER_DESCRIPTIONS[SCORERS.approval]),
  };
  const experimentId = newId();
  const traceId = experimentId.replaceAll("-", "");
  const described = (part: { id: string; label: string; file?: string }) =>
    `${part.id} (${part.file ? `${part.label} ${part.file}` : part.label})`;
  await posthog.createExperiment({
    id: experimentId,
    name: `components curator ${described(curator)}, judge ${described(judge)} ${startedAt}`,
    started_at: startedAt,
    run_source: "local",
    suite_key: SUITE,
    dataset_revision_id: dataset.revisionId,
    expected_item_count: cases.length,
    expected_result_count: cases.length * 2,
    model_version: [...new Set([AI_MODELS.decide, AI_MODELS.judge])].join(", "),
    prompt_version: curator.id,
    application_version: `judge ${judge.id}`.slice(0, 255),
  });
  log(`experiment ${experimentId}, curator ${described(curator)}, judge ${described(judge)}`);

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
                ai: deps.ai,
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
            runs.push({ repeat, picks: [], failed: outcome.reasons });
            log(`  ${c.reelId} run ${repeat}: no valid answer: ${outcome.reasons.join("; ")}`);
            continue;
          }
          const labelOf = (pick: ComponentPick): Labelled =>
            labelPick(pick, c.item.marks, c.item.nothing);
          const { picks } = picksOfAnswer(outcome.answer as TracedAnswer, c.transcript);
          const labelled = picks.map((pick) => ({ pick, label: labelOf(pick) }));
          const judged = judgePicks("curator", picks, labelOf, `${SEED}/${c.reelId}/${repeat}`);
          let judgeRecord: RunRecord["judge"] = null;
          const verdictOf = new Map<string, "approve" | "reject">();
          if (judged.length > 0) {
            const sent = judged.map((pick) => sentPick(pick, c.item.words));
            const answer = await inSpan(
              telemetry,
              rootContext,
              "eval.judge.call",
              { "reel.id": c.reelId, "eval.case": c.item.caseKey, "eval.source": "curator" },
              (_span, context) =>
                callJudge({
                  ai: deps.ai,
                  template: judgeTemplate,
                  transcript: c.transcript,
                  picks: sent,
                  trace: { telemetry, parent: context },
                }),
            );
            usage = addUsage(usage, answer.usage);
            if (answer.ok) {
              const byId = new Map(
                answer.verdicts.map((verdict: Verdict) => [verdict.pick, verdict]),
              );
              for (const pick of judged) {
                verdictOf.set(keyOf(pick), byId.get(pick.id)!.verdict);
              }
              judgeRecord = {
                judged: judged.length,
                approved: answer.verdicts.filter((verdict) => verdict.verdict === "approve").length,
              };
            } else {
              judgeRecord = { failed: answer.reasons };
            }
          }
          const score = scoreRun(labelled, c.item.marks);
          runs.push({
            repeat,
            score,
            judge: judgeRecord,
            picks: labelled.map(({ pick, label }) => ({
              component: pick.component,
              words: pickWords(pick, c.item.words),
              label: label.label,
              why: label.why,
              verdict: verdictOf.get(keyOf(pick)) ?? null,
            })),
          });
          const judgeLine =
            judgeRecord === null
              ? "no judge call"
              : "failed" in judgeRecord
                ? `judge no valid answer: ${judgeRecord.failed.join("; ")}`
                : `judge approves ${judgeRecord.approved} of ${judgeRecord.judged}`;
          log(
            `  ${c.reelId} run ${repeat}: ${picks.length} picks, ${score.overall.good} good, ${score.overall.matched} of ${score.overall.marks} marks matched, F1 ${String(prf(score.overall).f1?.toFixed(3) ?? "n/a")}, ${judgeLine}`,
          );
        }
        const scored = sumRuns(runs.flatMap((run) => (run.score ? [run.score] : [])));
        const approval = runs.reduce<Approval>(
          (total, run) =>
            run.judge && "judged" in run.judge
              ? {
                  judged: total.judged + run.judge.judged,
                  approved: total.approved + run.judge.approved,
                }
              : total,
          NO_APPROVAL,
        );
        results.push({
          built: c,
          runs,
          score: scored,
          approval,
          judgeFailed: runs.filter((run) => run.judge && "failed" in run.judge).length,
        });
      }
    } finally {
      root.end();
    }

    const overall = sumRuns(results.map((result) => result.score));
    const approvals = results.reduce<Approval>(
      (total, result) => ({
        judged: total.judged + result.approval.judged,
        approved: total.approved + result.approval.approved,
      }),
      NO_APPROVAL,
    );
    const curatorF1 = prf(overall.overall).f1;
    const judgeApproval = approvalRate(approvals);
    const report: CuratorReport = {
      startedAt,
      curator,
      judge,
      decideModel: AI_MODELS.decide,
      judgeModel: AI_MODELS.judge,
      repeats: options.repeats,
      datasetRevision: dataset.revision,
      experimentId,
      overall,
      approval: approvals,
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
        approval: result.approval,
      })),
      skipped,
    };
    const reportPath = await deps.saveReport(
      `curator-${startedAt.replaceAll(":", "-")}.html`,
      renderCuratorReport(report),
    );
    log(
      `curator F1 ${curatorF1 === null ? "n/a" : curatorF1.toFixed(3)}, judge approval ${judgeApproval === null ? "n/a" : (judgeApproval * 100).toFixed(1) + "%"} (${approvals.approved} of ${approvals.judged} distinct picks)`,
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
        judge,
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
      curatorF1,
      judgeApproval,
      reportPath,
    };
  } catch (error) {
    // The experiment exists: close it as failed, then report the real error.
    await posthog.fail(experimentId).catch(() => undefined);
    throw error;
  }
}
