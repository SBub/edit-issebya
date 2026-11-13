import { ISSEBYA_PRESET } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { transcriptOf } from "../../test-support/eval-fixtures.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { type AiExchange, type AiRequest, type AiResult, type AiRunner, NO_USAGE } from "../ai.ts";
import { decideInput } from "../decide/input.ts";
import { CURATOR_PROMPT_NAME, CuratorUnavailable, callCurator } from "./curator-call.ts";

const TRANSCRIPT = transcriptOf("we work to live and we live to work");
const INPUT = decideInput({
  transcript: TRANSCRIPT,
  preset: ISSEBYA_PRESET,
  hook: { text: "a hook" },
});
const EXCHANGE = {} as AiExchange;

// A components answer over the transcript's ids (every list present, as the schema asks).
const ANSWER = {
  accents: [{ from: "w2", to: "w4" }],
  questions: [],
  big_words: [],
  visuals: [],
  lists: [],
  word_fixes: [],
};

function scripted(results: AiResult[]): AiRunner & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    requests,
    async call(request) {
      requests.push(request);
      const next = results.shift();
      if (!next) throw new Error("no scripted reply left");
      return next;
    },
  };
}

const answer = (json: unknown): AiResult => ({
  kind: "answer",
  answer: json,
  usage: NO_USAGE,
  exchange: EXCHANGE,
});
const broken = (reason: string): AiResult => ({
  kind: "broken",
  reason,
  usage: NO_USAGE,
  exchange: EXCHANGE,
});
const unavailable = (reason: string): AiResult => ({
  kind: "unavailable",
  reason,
  usage: NO_USAGE,
  exchange: EXCHANGE,
});

async function template() {
  return fakePromptSource().get(CURATOR_PROMPT_NAME);
}

describe("the curator call", () => {
  it("answers once when the answer passes the schema and the checks", async () => {
    const ai = scripted([answer(ANSWER)]);
    const outcome = await callCurator({
      ai,
      template: await template(),
      input: INPUT,
      preset: ISSEBYA_PRESET,
      transcript: TRANSCRIPT,
      validate: () => ({ ok: true }),
    });
    expect(outcome.ok).toBe(true);
    expect(ai.requests).toHaveLength(1);
    expect(ai.requests[0]!.role).toBe("decide");
    expect(ai.requests[0]!.promptVersion).toBe("reel-components@v1");
  });

  it("sends the reasons back once when the answer is not JSON, then accepts the second", async () => {
    const ai = scripted([broken("unexpected end"), answer(ANSWER)]);
    const outcome = await callCurator({
      ai,
      template: await template(),
      input: INPUT,
      preset: ISSEBYA_PRESET,
      transcript: TRANSCRIPT,
      validate: () => ({ ok: true }),
    });
    expect(outcome.ok).toBe(true);
    expect(ai.requests).toHaveLength(2);
    expect(ai.requests[1]!.prompt).toContain("Your previous answer was refused");
    expect(ai.requests[1]!.prompt).toContain("the answer was not valid JSON: unexpected end");
  });

  it("refuses an answer the schema rejects, with the schema's reasons", async () => {
    const ai = scripted([
      answer({ ...ANSWER, accents: [{ from: "nope", to: "w4" }] }),
      answer(ANSWER),
    ]);
    const outcome = await callCurator({
      ai,
      template: await template(),
      input: INPUT,
      preset: ISSEBYA_PRESET,
      transcript: TRANSCRIPT,
      validate: () => ({ ok: true }),
    });
    expect(outcome.ok).toBe(true);
    expect(ai.requests[1]!.prompt).toContain("Your previous answer was refused");
  });

  it("refuses an answer the checks reject, and fails after the second refusal", async () => {
    const ai = scripted([answer(ANSWER), answer(ANSWER)]);
    let round = 0;
    const outcome = await callCurator({
      ai,
      template: await template(),
      input: INPUT,
      preset: ISSEBYA_PRESET,
      transcript: TRANSCRIPT,
      validate: () => {
        round += 1;
        return { ok: false, reasons: [`glossary check, round ${round}`] };
      },
    });
    expect(outcome.ok).toBe(false);
    expect(ai.requests).toHaveLength(2);
    expect(outcome.ok ? [] : outcome.reasons).toEqual(["glossary check, round 2"]);
  });

  it("throws when the AI cannot answer now, so the whole run stops", async () => {
    const ai = scripted([unavailable("no credits")]);
    await expect(
      callCurator({
        ai,
        template: await template(),
        input: INPUT,
        preset: ISSEBYA_PRESET,
        transcript: TRANSCRIPT,
        validate: () => ({ ok: true }),
      }),
    ).rejects.toBeInstanceOf(CuratorUnavailable);
  });
});
