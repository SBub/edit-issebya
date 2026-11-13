import { ISSEBYA_PRESET } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { transcriptOf } from "../../test-support/eval-fixtures.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { AI_MODELS, fakeAiRunner } from "../ai.ts";
import { decideInput, scriptOf } from "../decide/input.ts";
import { decidePrompt } from "../decide/prompt.ts";
import {
  JUDGE_PROMPT_NAME,
  JudgeUnavailable,
  callJudge,
  judgeJsonSchema,
  judgePrompt,
  parseJudgeAnswer,
} from "./judge-call.ts";
import type { SentPick } from "./label.ts";

const TRANSCRIPT = transcriptOf("We work to live. And we live to work.");
const PICKS: SentPick[] = [
  { pick: "p1", component: "accent", words: "work to live.", start: 1, end: 3.5 },
  { pick: "p2", component: "bigword", words: "work.", start: 7, end: 7.5 },
];
const verdict = (pick: string, approve = true) => ({
  pick,
  verdict: approve ? "approve" : "reject",
  reason: "because",
  better: approve ? null : "another word",
});
const GOOD = { verdicts: [verdict("p1"), verdict("p2", false)] };

describe("the judge's answer", () => {
  it("has a schema of one verdict object per pick", () => {
    expect(judgeJsonSchema()).toMatchObject({
      type: "object",
      required: ["verdicts"],
      properties: {
        verdicts: {
          type: "array",
          items: {
            required: ["pick", "verdict", "reason", "better"],
            properties: { verdict: { enum: ["approve", "reject"] } },
          },
        },
      },
    });
  });

  it("is accepted with exactly one verdict for every pick sent", () => {
    expect(parseJudgeAnswer(GOOD, ["p1", "p2"])).toEqual({ ok: true, verdicts: GOOD.verdicts });
  });

  it("is refused with the reasons: a pick missing, one twice, one never sent, a wrong shape", () => {
    expect(parseJudgeAnswer({ verdicts: [verdict("p1")] }, ["p1", "p2"])).toEqual({
      ok: false,
      reasons: ['"p2" has no verdict, give one for every pick'],
    });
    expect(
      parseJudgeAnswer({ verdicts: [verdict("p1"), verdict("p1"), verdict("p9")] }, ["p1"]),
    ).toEqual({
      ok: false,
      reasons: ['"p1" has two verdicts, give one', '"p9" is not a pick that was sent'],
    });
    const shape = parseJudgeAnswer({ verdicts: [{ pick: "p1", verdict: "maybe" }] }, ["p1"]);
    expect(shape.ok).toBe(false);
    expect(shape.ok ? [] : shape.reasons.join(" ")).toMatch(/verdicts\.0\.verdict/);
  });

  it("is refused when a verdict is neither approve nor reject", () => {
    const answer = { verdicts: [{ ...verdict("p1"), verdict: "unsure" }] };
    expect(parseJudgeAnswer(answer, ["p1"]).ok).toBe(false);
  });

  it("is refused when an approved pick carries a better, and accepted when a rejected one has none", () => {
    expect(parseJudgeAnswer({ verdicts: [{ ...verdict("p1"), better: "other" }] }, ["p1"])).toEqual(
      { ok: false, reasons: ['"p1" is approved, so its better must be null'] },
    );
    expect(
      parseJudgeAnswer({ verdicts: [{ ...verdict("p1", false), better: null }] }, ["p1"]).ok,
    ).toBe(true);
  });

  it("is refused with a field the schema does not have, or one missing", () => {
    expect(parseJudgeAnswer({ verdicts: [{ ...verdict("p1"), score: 1 }] }, ["p1"]).ok).toBe(false);
    expect(parseJudgeAnswer({ verdicts: [{ pick: "p1", verdict: "approve" }] }, ["p1"]).ok).toBe(
      false,
    );
    expect(parseJudgeAnswer({}, ["p1"]).ok).toBe(false);
  });
});

describe("the judge's prompt", () => {
  it("is filled with the script exactly as the curator's prompt receives it, and the picks", async () => {
    const prompts = fakePromptSource();
    const call = judgePrompt(await prompts.get(JUDGE_PROMPT_NAME), TRANSCRIPT, PICKS);
    expect(call.promptVersion).toBe("reel-components-judge@v1");
    // The curator's own prompt, filled from the same transcript: its script block.
    const curator = decidePrompt(
      await prompts.get("reel-components"),
      decideInput({ transcript: TRANSCRIPT, preset: ISSEBYA_PRESET, hook: { text: "A hook" } }),
    ).prompt;
    const from = curator.indexOf("```json");
    const script = curator.slice(from, curator.indexOf("\n```", from) + 4);
    expect(script).toContain('"id": "w9"');
    expect(call.prompt).toBe(
      `test prompt reel-components-judge ${script} ${["```json", JSON.stringify(PICKS, null, 2), "```"].join("\n")}`,
    );
  });

  it("with no placeholder in the prompt (a PostHog version or a draft), is the system message, the script and the picks the user message", async () => {
    const template = {
      ...(await fakePromptSource().get(JUDGE_PROMPT_NAME)),
      text: "test system prompt reel-components-judge",
    };
    const call = judgePrompt(template, TRANSCRIPT, PICKS);
    const fence = (value: unknown) => ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
    expect(call.system).toBe(template.text);
    expect(call.prompt).toBe(
      [
        "## script",
        "",
        fence(scriptOf(TRANSCRIPT, ISSEBYA_PRESET)),
        "",
        "## picks",
        "",
        fence(PICKS),
        "",
      ].join("\n"),
    );
  });
});

describe("callJudge", () => {
  const run = async (script: Parameters<typeof fakeAiRunner>[0]) => {
    const ai = fakeAiRunner(script);
    const template = await fakePromptSource().get(JUDGE_PROMPT_NAME);
    const outcome = callJudge({ ai, template, transcript: TRANSCRIPT, picks: PICKS });
    return { ai, outcome };
  };

  it("calls the judge role once when the answer is valid", async () => {
    const { ai, outcome } = await run([{ answer: GOOD, usage: { cost_usd: 0.01 } }]);
    expect(await outcome).toMatchObject({
      ok: true,
      verdicts: GOOD.verdicts,
      usage: { costUsd: 0.01, model: AI_MODELS.judge },
    });
    expect(ai.calls).toHaveLength(1);
    // Asked for as a strict structured output, not only in the prompt's words.
    const result = await ai.call(ai.calls[0]!);
    expect(result.exchange.outputMode).toBe("json_schema");
    expect(ai.calls[0]).toMatchObject({
      role: "judge",
      promptVersion: "reel-components-judge@v1",
      schema: judgeJsonSchema(),
    });
  });

  it("sends an invalid answer back once with its reasons, then takes the valid one", async () => {
    const { ai, outcome } = await run([
      { answer: { verdicts: [verdict("p1")] }, usage: { cost_usd: 0.01 } },
      { answer: GOOD, usage: { cost_usd: 0.02 } },
    ]);
    expect(await outcome).toMatchObject({ ok: true, usage: { costUsd: 0.03 } });
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]?.prompt).toContain("Your previous answer was refused for these reasons");
    expect(ai.calls[1]?.prompt).toContain('- "p2" has no verdict, give one for every pick');
  });

  it("gives up after the one retry, with the last reasons", async () => {
    const { ai, outcome } = await run(["not json"]);
    const failed = await outcome;
    expect(failed.ok).toBe(false);
    expect(failed.ok ? "" : failed.reasons[0]).toMatch(/^the answer was not valid JSON/);
    expect(ai.calls).toHaveLength(2);
  });

  it("stops the run when the AI cannot answer now", async () => {
    const { outcome } = await run([{ error: { status: 402 } }]);
    await expect(outcome).rejects.toThrow(JudgeUnavailable);
    await expect(outcome).rejects.toThrow(/the OpenRouter credits are used up/);
  });
});
