import type { Context } from "@opentelemetry/api";
import { ISSEBYA_PRESET, type Transcript } from "@edit-issebya/edit";
import { z } from "zod";
import { type AiRunner, NO_USAGE } from "../ai.ts";
import { scriptOf } from "../decide/input.ts";
import { fenced } from "../decide/prompt.ts";
import { type PromptText, renderPrompt } from "../prompts/source.ts";
import { type AiUsage, addUsage } from "../step-store.ts";
import type { Telemetry } from "../telemetry.ts";
import type { SentPick } from "./label.ts";

// THE JUDGE CALL: one AI call that reads a reel's script and a set of picks
// and answers approve or reject for each. Its prompt lives in PostHog under
// this name (never in the repository); it is not one of the worker's own
// prompts, so the doctor does not fetch it.
export const JUDGE_PROMPT_NAME = "reel-components-judge";

const answerSchema = z.strictObject({
  verdicts: z.array(
    z.strictObject({
      pick: z.string().min(1),
      verdict: z.enum(["approve", "reject"]),
      reason: z.string(),
      better: z.string().nullable(),
    }),
  ),
});

export type Verdict = z.infer<typeof answerSchema>["verdicts"][number];

// The answer's JSON Schema, the structured output of the call (the same
// draft-07 form as the decide step's).
export function judgeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(answerSchema, {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

// The answer checked again in code, whatever the structured output enforced:
// its shape (the same schema), then the rules a schema cannot hold: exactly
// one verdict for every pick sent (none missing, none twice, none for a pick
// that was not sent) and no `better` on an approved pick.
export function parseJudgeAnswer(
  json: unknown,
  pickIds: readonly string[],
): { ok: true; verdicts: Verdict[] } | { ok: false; reasons: string[] } {
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reasons: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`,
      ),
    };
  }
  const sent = new Set(pickIds);
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const { pick, verdict, better } of parsed.data.verdicts) {
    if (!sent.has(pick)) reasons.push(`"${pick}" is not a pick that was sent`);
    else if (seen.has(pick)) reasons.push(`"${pick}" has two verdicts, give one`);
    seen.add(pick);
    if (verdict === "approve" && better !== null) {
      reasons.push(`"${pick}" is approved, so its better must be null`);
    }
  }
  for (const id of pickIds) {
    if (!seen.has(id)) reasons.push(`"${id}" has no verdict, give one for every pick`);
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, verdicts: parsed.data.verdicts };
}

// The judge prompt filled in: `{{script}}` is the script exactly as the
// curator's prompt receives it (the same function, the same preset), and
// `{{picks}}` the picks as fenced JSON.
export function judgePrompt(
  template: PromptText,
  transcript: Transcript,
  picks: readonly SentPick[],
  previousReasons?: readonly string[],
) {
  return renderPrompt(
    template,
    { script: fenced(scriptOf(transcript, ISSEBYA_PRESET)), picks: fenced(picks) },
    previousReasons,
  );
}

// The AI cannot answer now (no key, no credits, a rate limit): the whole eval
// run stops, nothing is uploaded.
export class JudgeUnavailable extends Error {
  constructor(reason: string) {
    super(`evals: the judge cannot answer now: ${reason}`);
    this.name = "JudgeUnavailable";
  }
}

export type JudgeOutcome =
  | { ok: true; verdicts: Verdict[]; usage: AiUsage }
  | { ok: false; reasons: string[]; usage: AiUsage };

// One judge call, with one retry on an answer that is not valid (broken JSON,
// a wrong shape, a pick without its verdict), as the decide step does: the
// reasons go back once, a second invalid answer is the call's failure.
export async function callJudge({
  ai,
  template,
  transcript,
  picks,
  trace,
}: {
  ai: AiRunner;
  template: PromptText;
  transcript: Transcript;
  picks: readonly SentPick[];
  trace?: { telemetry: Telemetry; parent: Context };
}): Promise<JudgeOutcome> {
  const schema = judgeJsonSchema();
  const ids = picks.map((pick) => pick.pick);
  let usage = NO_USAGE;
  let reasons: string[] = [];
  for (const attempt of [1, 2]) {
    const result = await ai.call({
      role: "judge",
      ...judgePrompt(template, transcript, picks, attempt === 2 ? reasons : undefined),
      schema,
      ...(trace ? { trace } : {}),
    });
    usage = addUsage(usage, result.usage);
    if (result.kind === "unavailable") throw new JudgeUnavailable(result.reason);
    if (result.kind === "broken") {
      reasons = [`the answer was not valid JSON: ${result.reason}`];
      continue;
    }
    const parsed = parseJudgeAnswer(result.answer, ids);
    if (parsed.ok) return { ok: true, verdicts: parsed.verdicts, usage };
    reasons = parsed.reasons;
  }
  return { ok: false, reasons, usage };
}
