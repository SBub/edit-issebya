import type { Context } from "@opentelemetry/api";
import {
  type DecideAnswer,
  type EngineInput,
  type FontPairId,
  type Measurer,
  type Preset,
  type Transcript,
  type Edit,
  type HeadTrack,
  decideJsonSchema,
  editFromAnswer,
  glossaryChecks,
  parseDecideAnswer,
} from "@edit-issebya/edit";
import { type AiRunner, NO_USAGE } from "../ai.ts";
import { decidePrompt } from "../decide/prompt.ts";
import { type PromptText, PROMPT_NAMES } from "../prompts/source.ts";
import { type AiUsage, addUsage } from "../step-store.ts";
import type { Telemetry } from "../telemetry.ts";
import type { DecideInput } from "../decide/input.ts";

// THE CURATOR CALL: the decide step's components call (role `decide`, prompt
// `reel-components`) on one reel's input, with the same structured output and
// the same checks: the answer's JSON and schema, then the layout engine's
// placement and the glossary check (`editFromAnswer`, `glossaryChecks`). A
// refused answer goes back once with its reasons; a second refusal is the
// call's failure. The prompt's wording lives only in PostHog.
export const CURATOR_PROMPT_NAME = PROMPT_NAMES.components;

export class CuratorUnavailable extends Error {
  constructor(reason: string) {
    super(`evals: the curator cannot answer now: ${reason}`);
    this.name = "CuratorUnavailable";
  }
}

// One check of an answer: passes, or the reasons it is refused.
export type Validate = (answer: DecideAnswer) => { ok: true } | { ok: false; reasons: string[] };

export type CuratorOutcome =
  | { ok: true; answer: DecideAnswer; usage: AiUsage }
  | { ok: false; reasons: string[]; usage: AiUsage };

// The decide step's checks after the schema, as the decide step runs them: the
// answer is placed over the latest version with the written hook, and its
// composed edit must pass the glossary check. Layout never refuses an answer
// (an error here is an engine fault), so only the glossary can.
export function decideValidator({
  current,
  hookText,
  preset,
  transcript,
  headTrack,
  measure,
}: {
  current: Edit;
  hookText: string;
  preset: Preset;
  transcript: Transcript;
  headTrack: HeadTrack;
  measure: Measurer;
}): Validate {
  return (answer) => {
    const engine: EngineInput = { ...answer, hook: { text: hookText } };
    const composed = editFromAnswer(current, engine, preset, transcript, headTrack, measure);
    if (!composed.ok) return { ok: false, reasons: composed.reasons };
    const glossary = glossaryChecks(composed.edit, transcript, preset);
    if (glossary.length > 0) {
      return {
        ok: false,
        reasons: glossary.map((check) => `${check.rule} ${check.item}: ${check.reason}`),
      };
    }
    return { ok: true };
  };
}

// The measurer of a font pair, as the decide step loads it (the version's pair).
export type MeasurerOf = (pair: FontPairId) => Promise<Measurer>;

// One curator call with its one retry. `input` is the decide step's input for
// the reel; `template` the components prompt (PostHog or a draft).
export async function callCurator({
  ai,
  template,
  input,
  preset,
  transcript,
  validate,
  trace,
}: {
  ai: AiRunner;
  template: PromptText;
  input: DecideInput;
  preset: Preset;
  transcript: Transcript;
  validate: Validate;
  trace?: { telemetry: Telemetry; parent: Context };
}): Promise<CuratorOutcome> {
  const schema = decideJsonSchema(preset, transcript);
  let usage = NO_USAGE;
  let reasons: string[] = [];
  for (const attempt of [1, 2]) {
    const result = await ai.call({
      role: "decide",
      ...decidePrompt(template, input, attempt === 2 ? reasons : undefined),
      schema,
      ...(trace ? { trace } : {}),
    });
    usage = addUsage(usage, result.usage);
    if (result.kind === "unavailable") throw new CuratorUnavailable(result.reason);
    if (result.kind === "broken") {
      reasons = [`the answer was not valid JSON: ${result.reason}`];
      continue;
    }
    const parsed = parseDecideAnswer(result.answer, preset, transcript);
    if (!parsed.ok) {
      reasons = parsed.reasons;
      continue;
    }
    const checked = validate(parsed.answer);
    if (checked.ok) return { ok: true, answer: parsed.answer, usage };
    reasons = checked.reasons;
  }
  return { ok: false, reasons, usage };
}
