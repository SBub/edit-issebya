import { describe, expect, it } from "vitest";
import { answerResult, fixtureSources, roleAi } from "../../test-support/curator-fixtures.ts";
import { OPTIONS, setup } from "../../test-support/curator-run-setup.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { SCORING_VERSION, runCuratorEval } from "./run-curator.ts";

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
  it("asks the curator once per run, no judge, and uploads a scorer per column per reel", async () => {
    const { deps, posthogCalls, sent, ai } = setup();
    const summary = await runCuratorEval({ ...OPTIONS, repeats: 2 }, deps);

    expect(ai.calls.map((call) => call.role)).toEqual(["decide", "decide"]);
    expect(posthogCalls).toEqual([
      "dataset",
      "scorer curator_f1_overall",
      "scorer curator_f1_accent",
      "scorer curator_f1_bigword",
      "scorer curator_f1_list",
      "scorer curator_f1_question",
      "scorer curator_f1_visual",
      "create",
      "upload 00000000-0000-4000-8000-000000000001",
      "complete 00000000-0000-4000-8000-000000000001",
    ]);
    expect(summary.datasetRevision).toBe(6);
    expect(summary.summary?.f1.overall).toEqual({ mean: 1, min: 1, max: 1 });
    expect(summary.summary?.runs).toEqual({ ok: 2, total: 2 });

    expect(sent.experiment).toMatchObject({
      suite_key: "components-curator",
      dataset_revision_id: "revision-6",
      prompt_version: "reel-components@v1",
      application_version: SCORING_VERSION,
      expected_item_count: 1,
      expected_result_count: 6,
    });
    const results = sent.upload!.results;
    expect(
      results.map((result) => [result.scorer_version_id, result.status, result.value]),
    ).toEqual([
      ["curator_f1_overall-version", "ok", 1],
      ["curator_f1_accent-version", "ok", 1],
      ["curator_f1_bigword-version", "ok", 1],
      ["curator_f1_list-version", "skipped", undefined],
      ["curator_f1_question-version", "skipped", undefined],
      ["curator_f1_visual-version", "ok", 1],
    ]);
    const item = sent.upload!.items[0]!;
    expect(item.payload.metadata).toMatchObject({
      curator_prompt_version: "reel-components@v1",
      curator_prompt_label: "production",
      curator_model: expect.any(String),
      scoring: SCORING_VERSION,
      repeats: 2,
      curator_runs_ok: 2,
    });
    expect(item.payload.metadata).not.toHaveProperty("judge_model");
    expect(item.payload.expected_output).toEqual({
      marks: [
        { component: "accent", words: "work to live" },
        { component: "bigword", words: "day" },
        { component: "visual", words: "we" },
      ],
    });
    const runs = (item.payload.output as { runs: { picks: { label: string }[] }[] }).runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.picks.map((pick) => pick.label)).toEqual(["good", "good", "good"]);
  });

  it("records the prompt version and label it ran, a labelled draft included", async () => {
    const { deps, sent } = setup();
    await runCuratorEval(OPTIONS, { ...deps, curatorPrompts: fakePromptSource("draft", 7) });
    expect(sent.experiment!.prompt_version).toBe("reel-components@v7");
    expect(sent.experiment!.name).toContain("reel-components@v7 (draft)");
    expect(sent.upload!.items[0]!.payload.metadata).toMatchObject({
      curator_prompt_version: "reel-components@v7",
      curator_prompt_label: "draft",
    });
  });

  it("sends a prompt with no placeholder as the system message, the inputs as the user message", async () => {
    const text = "a curator with no placeholder";
    const { deps, ai } = setup();
    await runCuratorEval(OPTIONS, {
      ...deps,
      curatorPrompts: { get: async (name) => ({ name, version: 3, label: "draft", text }) },
    });
    const call = ai.calls.find((one) => one.role === "decide")!;
    expect(call.system).toBe(text);
    expect(call.prompt.startsWith("## script\n\n```json\n")).toBe(true);
    for (const heading of ["hook", "intensity", "target_picks"]) {
      expect(call.prompt).toContain(`\n## ${heading}\n\n`);
    }
  });

  it("names the eval run as the trace of every call's generation event, with its reel", async () => {
    const { deps, sent, ai } = setup();
    await runCuratorEval(OPTIONS, deps);
    const sources = new Set<unknown>();
    for (const call of ai.calls) {
      expect(call.observe?.traceId).toBe(sent.experiment!.id);
      expect(typeof call.observe?.reelId).toBe("string");
      sources.add(call.observe?.properties?.source);
    }
    expect(sources).toEqual(new Set(["eval:curator"]));
  });

  it("marks the curator's results an error when it gives no valid answer twice", async () => {
    const { deps, sent, ai } = setup({
      ai: roleAi(() => answerResult({ accents: "nope" })),
    });
    await runCuratorEval(OPTIONS, deps);
    expect(ai.calls.map((call) => call.role)).toEqual(["decide", "decide"]);
    const results = sent.upload!.results;
    expect(results.map((result) => result.status)).toEqual(Array(6).fill("error"));
    expect(results[0]).toMatchObject({ status: "error", error_code: "curator_answer_invalid" });
    expect(sent.upload!.items[0]!.payload.metadata).toMatchObject({ curator_runs_failed: 1 });
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
