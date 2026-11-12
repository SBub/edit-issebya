import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { ownerItemJson } from "../../test-support/eval-fixtures.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import {
  ANSWER,
  OWNER,
  TEXT,
  answerResult,
  fixtureSources,
  noMeasurer,
  parseEditStub,
  roleAi,
  sentPicksOf,
} from "../../test-support/curator-fixtures.ts";
import type { AiRequest, AiResult } from "../ai.ts";
import { createTelemetry } from "../telemetry.ts";
import { draftId } from "./draft-prompt.ts";
import type { EvalsApi, ExperimentBody, UploadBody } from "./posthog-evals.ts";
import { type CuratorEvalDeps, type CuratorEvalOptions, runCuratorEval } from "./run-curator.ts";
import type { CuratorSources } from "./curator-input.ts";

// The answer the curator gives: the owner's accent and big word.
const CURATOR_ANSWER = { ...ANSWER, lists: [] };

// The curator answers `CURATOR_ANSWER`; the judge approves every pick it is sent.
function reply(request: AiRequest): AiResult {
  if (request.role === "judge") {
    return answerResult({
      verdicts: sentPicksOf(request).map((pick) => ({
        pick: pick.pick,
        verdict: "approve",
        reason: `about ${pick.words}`,
        better: null,
      })),
    });
  }
  return answerResult(CURATOR_ANSWER);
}

const DATASET = {
  revisionId: "revision-6",
  revision: 6,
  items: [ownerItemJson(TEXT, OWNER)],
};

function setup({
  ai = roleAi(reply),
  sources = fixtureSources(),
  overrides = {},
}: {
  ai?: ReturnType<typeof roleAi>;
  sources?: CuratorSources;
  overrides?: Partial<EvalsApi>;
} = {}) {
  const posthogCalls: string[] = [];
  const sent: { experiment?: ExperimentBody; upload?: UploadBody } = {};
  const posthog: EvalsApi = {
    async dataset() {
      posthogCalls.push("dataset");
      return DATASET;
    },
    async scorerVersion(name) {
      posthogCalls.push(`scorer ${name}`);
      return `${name}-version`;
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
  const lines: string[] = [];
  const reports: string[] = [];
  let ids = 0;
  const deps: CuratorEvalDeps = {
    posthog,
    sources,
    curatorPrompts: fakePromptSource(),
    judgePrompts: fakePromptSource(),
    ai,
    telemetry: createTelemetry({}, { spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
    measurerOf: noMeasurer,
    parseCurrent: parseEditStub,
    validatorOf: () => () => ({ ok: true }),
    async saveReport(name, html) {
      reports.push(html);
      return `/out/${name}`;
    },
    log: (line) => lines.push(line),
    now: () => new Date("2026-11-12T10:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-00000000000${(ids += 1)}`,
  };
  return { deps, posthogCalls, sent, ai, lines, reports };
}

const OPTIONS: CuratorEvalOptions = { datasetId: "data-set", dryRun: false, repeats: 1 };

describe("a dry run", () => {
  it("prints the inputs and makes no AI call, no experiment and no upload", async () => {
    const { deps, posthogCalls, ai, lines } = setup();
    const summary = await runCuratorEval({ ...OPTIONS, dryRun: true, repeats: 2 }, deps);
    expect(ai.calls).toEqual([]);
    expect(posthogCalls).toEqual(["dataset"]);
    expect(summary.built).toBe(1);
    expect(lines.join("\n")).toContain("dry run: no AI call, no upload");
    expect(lines.join("\n")).toContain("2 curator calls");
  });

  it("names a reel it cannot rebuild and carries on", async () => {
    const { deps, ai } = setup({ sources: fixtureSources({ latest: null }) });
    const summary = await runCuratorEval({ ...OPTIONS, dryRun: true }, deps);
    expect(summary.built).toBe(0);
    expect(summary.skipped).toEqual([
      { reel: expect.any(String), reason: expect.stringContaining("no version") },
    ]);
    expect(ai.calls).toEqual([]);
  });
});

describe("a run", () => {
  it("asks the curator and the judge once each per run, and uploads both scorers per reel", async () => {
    const { deps, posthogCalls, sent, ai } = setup();
    const summary = await runCuratorEval({ ...OPTIONS, repeats: 2 }, deps);

    expect(ai.calls.map((call) => call.role)).toEqual(["decide", "judge", "decide", "judge"]);
    expect(posthogCalls).toEqual([
      "dataset",
      "scorer curator_f1",
      "scorer judge_approval",
      "create",
      "upload 00000000-0000-4000-8000-000000000001",
      "complete 00000000-0000-4000-8000-000000000001",
    ]);
    expect(summary.curatorF1).toBe(1);
    expect(summary.judgeApproval).toBe(1);

    expect(sent.experiment).toMatchObject({
      suite_key: "components-curator",
      dataset_revision_id: "revision-6",
      prompt_version: "reel-components@v1",
      application_version: "judge reel-components-judge@v1",
      expected_item_count: 1,
      expected_result_count: 2,
    });
    const results = sent.upload!.results;
    expect(
      results.map((result) => [result.scorer_version_id, result.status, result.value]),
    ).toEqual([
      ["curator_f1-version", "ok", 1],
      ["judge_approval-version", "ok", 1],
    ]);
    const item = sent.upload!.items[0]!;
    expect(item.payload.metadata).toMatchObject({
      curator_prompt_version: "reel-components@v1",
      judge_prompt_version: "reel-components-judge@v1",
      curator_model: expect.any(String),
      judge_model: expect.any(String),
      repeats: 2,
      curator_runs_ok: 2,
    });
    expect(item.payload.expected_output).toEqual({
      marks: [
        { component: "accent", words: "work to live" },
        { component: "bigword", words: "day" },
      ],
    });
    const runs = (
      item.payload.output as { runs: { picks: { verdict: string; label: string }[] }[] }
    ).runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.picks.map((pick) => [pick.label, pick.verdict])).toEqual([
      ["good", "approve"],
      ["good", "approve"],
    ]);
  });

  it("records a draft curator prompt by its hash and file, and sends its text", async () => {
    const text = "a draft curator, {{script}} {{hook}}";
    const { deps, sent, ai } = setup();
    await runCuratorEval(
      {
        ...OPTIONS,
        curatorDraft: { text, file: "curator-draft.txt", id: draftId(text) },
      },
      deps,
    );
    const curatorCall = ai.calls.find((call) => call.role === "decide")!;
    expect(curatorCall.promptVersion).toBe("draft@v0");
    expect(curatorCall.prompt.startsWith("a draft curator,")).toBe(true);
    expect(sent.experiment!.prompt_version).toBe(draftId(text));
    expect(sent.experiment!.name).toContain("curator-draft.txt");
    expect(sent.upload!.items[0]!.payload.metadata).toMatchObject({
      curator_prompt_version: draftId(text),
      curator_prompt_label: "draft",
      curator_prompt_file: "curator-draft.txt",
      judge_prompt_version: "reel-components-judge@v1",
    });
  });

  it("marks the curator's result an error when it gives no valid answer twice, and makes no judge call", async () => {
    const { deps, sent, ai } = setup({
      ai: roleAi(() => answerResult({ accents: "nope" })),
    });
    await runCuratorEval(OPTIONS, deps);
    expect(ai.calls.map((call) => call.role)).toEqual(["decide", "decide"]);
    const [f1, approval] = sent.upload!.results;
    expect(f1).toMatchObject({ status: "error", error_code: "curator_answer_invalid" });
    expect(approval).toMatchObject({ status: "skipped" });
    expect(sent.upload!.items[0]!.payload.metadata).toMatchObject({ curator_runs_failed: 1 });
  });

  it("marks the judge's result an error when the judge gives no valid answer", async () => {
    const { deps, sent } = setup({
      ai: roleAi((request) =>
        request.role === "judge" ? answerResult({ verdicts: [] }) : answerResult(CURATOR_ANSWER),
      ),
    });
    await runCuratorEval(OPTIONS, deps);
    const [, approval] = sent.upload!.results;
    expect(approval).toMatchObject({ status: "error", error_code: "judge_answer_invalid" });
  });

  it("fails the experiment, not the run, when the upload is refused", async () => {
    const { deps, posthogCalls } = setup({
      overrides: {
        async upload() {
          throw new Error("refused");
        },
      },
    });
    await expect(runCuratorEval(OPTIONS, deps)).rejects.toThrow("refused");
    expect(posthogCalls.at(-1)).toMatch(/^fail /);
  });

  it("stops with the AI's reason when the AI cannot answer", async () => {
    const { deps, sent } = setup({
      ai: roleAi(() => ({
        kind: "unavailable",
        reason: "no credits",
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          model: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
        exchange: {} as never,
      })),
    });
    await expect(runCuratorEval(OPTIONS, deps)).rejects.toThrow("no credits");
    expect(sent.upload).toBeUndefined();
  });
});
