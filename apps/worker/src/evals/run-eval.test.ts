import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { ownerItemJson, transcriptOf } from "../../test-support/eval-fixtures.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { type AiExchange, type AiRequest, type AiRunner, NO_USAGE } from "../ai.ts";
import { createTelemetry } from "../telemetry.ts";
import type { RunSources } from "./curator-runs.ts";
import type { SentPick } from "./label.ts";
import type { EvalsApi, ExperimentBody, UploadBody } from "./posthog-evals.ts";
import { type EvalDeps, runJudgeEval } from "./run-eval.ts";

const TEXT_A = "we work to live and we live to work every day";
const TEXT_B = "another reel with other words";
const REEL_A = "aaaaaaaa-0000-4000-8000-000000000001";
const key = (version: string) => `dev/reels/${REEL_A}/versions/${version}.ai.json`;
const V2 = "00000000-0000-4000-8000-0000000000a2";
const V3 = "00000000-0000-4000-8000-0000000000a3";

const record = (answer: unknown) => ({
  prompt_version: "reel-components@v7",
  calls: [{ role: "decide", answerText: JSON.stringify(answer) }],
});

// Reel A has two stored curator runs; reel B has none.
const sources: RunSources = {
  async aiFiles() {
    return [
      { reelId: REEL_A, key: key(V2) },
      { reelId: REEL_A, key: key(V3) },
    ];
  },
  async versions(ids) {
    return ids.map((id) => ({ id, number: id === V2 ? 2 : 3, transcriptKey: "transcript-a" }));
  },
  async readJson(at) {
    if (at === "transcript-a") return transcriptOf(TEXT_A);
    // The owner's accent again, and a big word the owner did not mark.
    if (at === key(V2)) {
      return record({
        accents: [{ from: "w2", to: "w4" }],
        big_words: [{ from: "w6", to: "w6" }],
      });
    }
    if (at === key(V3)) return record({ accents: [{ from: "w8", to: "w9" }] });
    return null;
  },
};

const DATASET = {
  revisionId: "revision-6",
  revision: 6,
  items: [
    ownerItemJson(TEXT_A, {
      accent: [{ start: 1, end: 3.5, words: "work to live" }],
      bigword: [{ start: 10, end: 10.5, words: "day" }],
    }),
    ownerItemJson(
      TEXT_B,
      { accent: [{ start: 0, end: 1.5, words: "another reel" }] },
      { reelId: "bbbbbbbb", id: "item-b" },
    ),
  ],
};

// A judge that approves every accent and rejects the rest; it answers a call
// holding the pick "to work" with no verdict at all (an invalid answer).
function judge(): AiRunner & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      const blocks = request.prompt.split("```json\n");
      const picks = JSON.parse(blocks.at(-1)!.split("\n```")[0]!) as SentPick[];
      const answer = picks.some((pick) => pick.words === "to work")
        ? { verdicts: [] }
        : {
            verdicts: picks.map((pick) => ({
              pick: pick.pick,
              verdict: pick.component === "accent" ? "approve" : "reject",
              reason: `about ${pick.words}`,
              better: null,
            })),
          };
      return {
        kind: "answer",
        answer,
        usage: { ...NO_USAGE, costUsd: 0.01 },
        exchange: {} as AiExchange,
      };
    },
  };
}

function setup(overrides: Partial<EvalsApi> = {}) {
  const posthogCalls: string[] = [];
  const sent: { experiment?: ExperimentBody; upload?: UploadBody } = {};
  const posthog: EvalsApi = {
    async dataset() {
      posthogCalls.push("dataset");
      return DATASET;
    },
    async scorerVersion(name) {
      posthogCalls.push(`scorer ${name}`);
      return "scorer-version-1";
    },
    async createExperiment(body) {
      posthogCalls.push("create");
      sent.experiment = body;
    },
    async upload(id, body) {
      posthogCalls.push(`upload ${id}`);
      sent.upload = body;
    },
    async complete(id) {
      posthogCalls.push(`complete ${id}`);
    },
    async fail(id) {
      posthogCalls.push(`fail ${id}`);
    },
    ...overrides,
  };
  const exporter = new InMemorySpanExporter();
  const ai = judge();
  const lines: string[] = [];
  const reports: { name: string; html: string }[] = [];
  let ids = 0;
  const deps: EvalDeps = {
    posthog,
    sources,
    prompts: fakePromptSource(),
    ai,
    telemetry: createTelemetry({}, { spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
    async saveReport(name, html) {
      reports.push({ name, html });
      return `/out/${name}`;
    },
    log: (line) => lines.push(line),
    now: () => new Date("2026-11-12T10:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-00000000000${(ids += 1)}`,
  };
  return { deps, posthogCalls, sent, exporter, ai, lines, reports };
}

const OPTIONS = { datasetId: "data-set", dryRun: false };

describe("a dry run", () => {
  it("prints the counts per reel and makes no judge call, no report and no upload", async () => {
    const { deps, posthogCalls, ai, lines, reports } = setup();
    const summary = await runJudgeEval({ ...OPTIONS, dryRun: true }, deps);
    expect(summary).toEqual({
      reels: [
        {
          reel: "aaaaaaaa",
          curatorRuns: 2,
          differingRuns: 0,
          ownerCalls: 1,
          ownerMarks: 2,
          curatorPicks: 3,
          good: 1,
          bad: 2,
          why: { extra: 2 },
          judgePicks: 5,
        },
        {
          reel: "bbbbbbbb",
          curatorRuns: 0,
          differingRuns: 0,
          ownerCalls: 0,
          ownerMarks: 1,
          curatorPicks: 0,
          good: 0,
          bad: 0,
          why: {},
          judgePicks: 0,
        },
      ],
    });
    expect(posthogCalls).toEqual(["dataset"]);
    expect(ai.calls).toEqual([]);
    expect(reports).toEqual([]);
    expect(lines).toContain(
      "reel aaaaaaaa: 2 curator runs, 2 owner marks, 3 curator picks (1 good, 2 bad: extra 2), 3 judge calls, 5 judge picks",
    );
    expect(lines).toContain(
      "total: 3 judge calls (1 owner, 2 curator), 3 owner marks, 3 curator picks (1 good, 2 bad), 5 judge picks",
    );
    expect(lines).toContain("  owner marks: 2 judge picks");
    expect(lines).toContain("  aaaaaaaa v2 reel-components@v7: 2 picks, 2 judge picks");
    expect(lines.at(-1)).toBe("dry run: no judge call, no upload");
  });

  it("keeps to one labelled reel with a reel id, and fails on one the dataset does not have", async () => {
    const { deps } = setup();
    const one = await runJudgeEval({ ...OPTIONS, dryRun: true, reel: "bbbbbbbb-1111" }, deps);
    expect(one.reels.map((counts) => counts.reel)).toEqual(["bbbbbbbb"]);
    await expect(runJudgeEval({ ...OPTIONS, dryRun: true, reel: "dddd" }, deps)).rejects.toThrow(
      "evals: no labelled reel dddd in the dataset",
    );
  });
});

describe("a judged run", () => {
  it("judges the owner's marks once, each curator run once (one retry on an invalid answer), never the curator", async () => {
    const { deps, ai } = setup();
    await runJudgeEval(OPTIONS, deps);
    // The owner's marks once; run v2 once; run v3 twice (its answer stays invalid).
    expect(ai.calls.map((call) => call.role)).toEqual(["judge", "judge", "judge", "judge"]);
    expect(ai.calls.every((call) => call.promptVersion === "reel-components-judge@v1")).toBe(true);
    expect(ai.calls.every((call) => call.trace !== undefined)).toBe(true);
    expect(ai.calls[3]?.prompt).toContain("Your previous answer was refused");
    // The judge sees picks, never where one came from or its label.
    for (const call of ai.calls) expect(call.prompt).not.toMatch(/owner|curator|good|bad|label/);
  });

  it("keeps the owner's marks and each curator run's picks in separate calls", async () => {
    const { deps, ai } = setup();
    await runJudgeEval(OPTIONS, deps);
    const sentOf = (prompt: string) =>
      (JSON.parse(prompt.split("```json\n").at(-1)!.split("\n```")[0]!) as SentPick[]).map(
        (pick) => pick.words,
      );
    expect(ai.calls.map((call) => sentOf(call.prompt).sort())).toEqual([
      ["day", "work to live"],
      ["we", "work to live"],
      ["to work"],
      ["to work"],
    ]);
  });

  it("creates the experiment before any judge call, pinned to the dataset revision", async () => {
    const { deps, posthogCalls, sent } = setup();
    const summary = await runJudgeEval(OPTIONS, deps);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(posthogCalls).toEqual([
      "dataset",
      "scorer judge_agreement",
      "create",
      `upload ${id}`,
      `complete ${id}`,
    ]);
    expect(sent.experiment).toEqual({
      id,
      name: "components judge reel-components-judge@v1 (production) 2026-11-12T10:00:00.000Z",
      started_at: "2026-11-12T10:00:00.000Z",
      run_source: "local",
      suite_key: "components-judge",
      dataset_revision_id: "revision-6",
      expected_item_count: 2,
      expected_result_count: 2,
      model_version: "anthropic/claude-haiku-5.5",
      prompt_version: "reel-components-judge@v1",
      application_version: "reel-components@v7",
    });
    expect(summary.experimentId).toBe(id);
    expect(summary.agreement).toBeCloseTo(3 / 4);
  });

  it("uploads one item and one judge_agreement result per labelled reel", async () => {
    const { deps, sent } = setup();
    await runJudgeEval(OPTIONS, deps);
    const { items, results } = sent.upload!;
    expect(items.map((item) => [item.case_key, item.dataset_item_version_id])).toEqual([
      ["owner-reels-aaaaaaaa", "item-a-version"],
      ["owner-reels-bbbbbbbb", "item-b-version"],
    ]);
    const metadata = {
      reel_id: "aaaaaaaa",
      judge_prompt_version: "reel-components-judge@v1",
      judge_prompt_label: "production",
      judge_model: "anthropic/claude-haiku-5.5",
      curator_prompt_versions: ["reel-components@v7"],
    };
    expect(items[0]?.payload.metadata).toEqual(metadata);
    const owner = { source: "owner" };
    const run = {
      source: "curator",
      curator_reel_id: REEL_A,
      curator_version_id: V2,
      curator_prompt_version: "reel-components@v7",
    };
    const payload = items[0]!.payload as {
      input: { calls: ({ picks: SentPick[] } & Record<string, unknown>)[] };
      output: { calls: Record<string, unknown>[] };
      expected_output: { calls: { labels: { pick: string; label: string; why: string }[] }[] };
    };
    // The owner's marks in their own call, then one call per curator run.
    expect(payload.input.calls[0]).toMatchObject(owner);
    expect(payload.input.calls[1]).toMatchObject(run);
    expect(payload.input.calls.map((call) => call.picks.map((pick) => pick.words).sort())).toEqual([
      ["day", "work to live"],
      ["we", "work to live"],
      ["to work"],
    ]);
    const labels = (call: number) =>
      payload.expected_output.calls[call]?.labels.map(({ label, why }) => `${label} ${why}`).sort();
    expect(labels(0)).toEqual(["good owner", "good owner"]);
    expect(labels(1)).toEqual(["bad extra", "good match"]);
    expect(payload.output.calls[0]).toMatchObject({ ...owner, verdicts: expect.any(Array) });
    expect(payload.output.calls[1]).toMatchObject({ ...run, verdicts: expect.any(Array) });
    // The call that stayed invalid is marked failed, never guessed.
    expect(payload.output.calls[2]).toEqual({
      ...run,
      curator_version_id: V3,
      error: ['"p1" has no verdict, give one for every pick'],
    });

    expect(results[0]).toMatchObject({
      item_id: items[0]?.id,
      scorer_version_id: "scorer-version-1",
      status: "ok",
      evaluator_trace_id: "00000000000040008000000000000001",
      evaluated_at: "2026-11-12T10:00:00.000Z",
      payload: {
        reasoning:
          "the judge agrees with the owner's label on 3 of 4 picks over 2 of 3 judge calls (owner marks 50.0%, curator picks 100.0%)",
        metadata: {
          ...metadata,
          total: 4,
          agree: 3,
          approveGood: 2,
          rejectBad: 1,
          rejectGood: 1,
          approveBad: 0,
          owner_agreement: 0.5,
          owner_picks: 2,
          curator_agreement: 1,
          curator_picks: 2,
          owner_calls: 1,
          curator_runs: 2,
          calls: [
            { ...owner, agreement: 0.5 },
            { ...run, agreement: 1 },
            { ...run, curator_version_id: V3, agreement: null },
          ],
        },
      },
    });
    expect(results[0]?.value).toBeCloseTo(3 / 4);
    // No stored curator run: skipped, with no value.
    expect(results[1]).toMatchObject({ item_id: items[1]?.id, status: "skipped" });
    expect(results[1]).not.toHaveProperty("value");
  });

  it("uploads an error for a reel whose every judge call stayed invalid", async () => {
    const { deps, sent } = setup();
    const only: RunSources = {
      ...sources,
      aiFiles: async () => [{ reelId: REEL_A, key: key(V3) }],
    };
    // Every answer is empty: the owner's marks' call and the run's call both stay invalid.
    const refuses: AiRunner = {
      async call() {
        return {
          kind: "answer",
          answer: { verdicts: [] },
          usage: NO_USAGE,
          exchange: {} as AiExchange,
        };
      },
    };
    await runJudgeEval({ ...OPTIONS, reel: "aaaaaaaa" }, { ...deps, sources: only, ai: refuses });
    expect(sent.experiment).toMatchObject({ expected_item_count: 1, expected_result_count: 1 });
    expect(sent.upload?.results).toHaveLength(1);
    expect(sent.upload?.results[0]).toMatchObject({
      status: "error",
      error_code: "judge_answer_invalid",
      payload: { error_message: expect.stringContaining("has no verdict") },
    });
    expect(sent.upload?.results[0]).not.toHaveProperty("value");
  });

  it("writes the report with the disagreement and the failed call", async () => {
    const { deps, reports, lines } = setup();
    const summary = await runJudgeEval(OPTIONS, deps);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.name).toBe("judge-2026-11-12T10-00-00.000Z.html");
    expect(summary.reportPath).toBe(`/out/${reports[0]?.name}`);
    const html = reports[0]!.html;
    expect(html).toContain("<h2>Disagreements (1)</h2>");
    expect(html).toContain("<td>bigword</td><td>day</td>");
    expect(html).toContain("about day");
    expect(html).toContain("Judge calls with no valid answer");
    expect(lines).toContain("agreement 75.0% (3 of 4 picks); approve/bad 0, reject/good 1");
    expect(lines).toContain("  owner marks: 50.0% (1 of 2)");
    expect(lines).toContain("  curator picks: 100.0% (2 of 2)");
    expect(html).toContain('<th scope="row">Owner marks</th>');
    expect(html).toContain('<th scope="row">Curator picks</th>');
    expect(lines).toContain("judge cost: $0.0400");
  });

  it("traces the run: one root span, one span per judge call under it", async () => {
    const { deps, exporter } = setup();
    await runJudgeEval(OPTIONS, deps);
    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "eval.judge");
    expect(root?.spanContext().traceId).toBe("00000000000040008000000000000001");
    const calls = spans.filter((span) => span.name === "eval.judge.call");
    expect(calls).toHaveLength(3);
    expect(
      calls.every((span) => span.parentSpanContext?.spanId === root?.spanContext().spanId),
    ).toBe(true);
    expect(calls[0]?.attributes).toMatchObject({ "reel.id": "aaaaaaaa", "eval.source": "owner" });
    expect(calls[1]?.attributes).toMatchObject({
      "reel.id": REEL_A,
      "eval.source": "curator",
      "eval.curator_version_id": V2,
      "eval.curator_prompt_version": "reel-components@v7",
    });
  });

  it("closes the experiment as failed when the upload fails, and reports the real error", async () => {
    const { deps, posthogCalls } = setup({
      async upload() {
        throw new Error("upload refused");
      },
    });
    await expect(runJudgeEval(OPTIONS, deps)).rejects.toThrow("upload refused");
    expect(posthogCalls.at(-1)).toBe("fail 00000000-0000-4000-8000-000000000001");
    expect(posthogCalls).not.toContain("complete 00000000-0000-4000-8000-000000000001");
  });

  it("makes no judge call when the experiment cannot be created", async () => {
    const { deps, ai } = setup({
      async createExperiment() {
        throw new Error("needs the offline_evaluation_ingestion:write scope");
      },
    });
    await expect(runJudgeEval(OPTIONS, deps)).rejects.toThrow(/offline_evaluation_ingestion/);
    expect(ai.calls).toEqual([]);
  });
});
