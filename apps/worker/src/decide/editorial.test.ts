import {
  type DecideAnswer,
  type Edit,
  ISSEBYA_PRESET,
  type Transcript,
  type UnplacedItem,
} from "@edit-issebya/edit";
import { type Context, ROOT_CONTEXT, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { AI_MODEL, type ScriptedReply, fakeAiRunner, scriptedAnswer } from "../ai.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PROMPT_NAMES, type PromptText } from "../prompts/source.ts";
import { type InSpan, type Telemetry, createTelemetry, inSpan } from "../telemetry.ts";
import {
  EDITORIAL_ROUNDS,
  type Placed,
  editorialPrompt,
  editorialInput,
  runEditorialRounds,
} from "./editorial.ts";

const EDITORIAL: PromptText = await fakePromptSource().get(PROMPT_NAMES.editorial);

// The rounds apart from the layout: a stub places each answer. The fixture
// clip of run-decide.test.ts is one sentence, so it never has a free
// sentence; these cover the rounds with two sentences instead.
const transcript: Transcript = {
  words: [
    { id: "w0001", text: "Hello", start: 0, end: 0.4 },
    { id: "w0002", text: "there", start: 0.4, end: 0.8 },
    { id: "w0003", text: "friend.", start: 0.8, end: 1.2 },
    { id: "w0004", text: "We", start: 2, end: 2.3 },
    { id: "w0005", text: "cook", start: 2.3, end: 2.7 },
    { id: "w0006", text: "pasta", start: 2.7, end: 3.1 },
    { id: "w0007", text: "today.", start: 3.1, end: 3.6 },
  ],
};
const edit = {} as Edit;

const ANSWER: DecideAnswer = {
  accents: [],
  big_words: [],
  visuals: [{ from: "w0001", to: "w0003", description: "a messy desk at night" }],
  transitions: [],
  word_fixes: [],
};

const left = (requested = false): UnplacedItem => ({
  ref: "visuals[0]",
  id: "visual-1",
  kind: "visual",
  from: "w0001",
  to: "w0003",
  requested,
  why: "no-room",
});
const FREE = [{ from: "w0004", to: "w0007", room_for: ["visual" as const] }];
const dropped = {
  item: "visual-1",
  action: "dropped" as const,
  rule: "no-room",
  reason: "visual 1: every spot is under captions or the face from 0.00 s to 2.00 s",
};
const unplacedPass = (free = FREE): Placed => ({
  edit,
  record: [dropped],
  unplaced: [left()],
  free,
});
const placedPass: Placed = { edit, record: [], unplaced: [], free: [] };

const move = scriptedAnswer({
  choices: [{ item: "visuals[0]", skip: false, from: "w0004", to: "w0007" }],
});

function rounds({
  script,
  placed = unplacedPass(),
  place = () => placedPass,
  check = (json: unknown) => ({ ok: true as const, answer: json as DecideAnswer }),
  answer = ANSWER,
  inRound,
  telemetry,
}: {
  script: ScriptedReply[];
  placed?: Placed;
  place?: (answer: DecideAnswer, context: Context) => Placed | null;
  check?: (json: unknown) => { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] };
  answer?: DecideAnswer;
  inRound?: InSpan;
  telemetry?: Telemetry;
}) {
  const ai = fakeAiRunner(script);
  const run = runEditorialRounds({
    ai,
    editorial: EDITORIAL,
    transcript,
    preset: ISSEBYA_PRESET,
    check,
    place,
    answer,
    placed,
    ...(inRound ? { inRound } : {}),
    ...(telemetry ? { telemetry } : {}),
  });
  return { ai, run };
}

describe("runEditorialRounds", () => {
  it("makes exactly one round on the automatic run when a left-out item has a free sentence", async () => {
    const placedAnswers: DecideAnswer[] = [];
    const { ai, run } = rounds({
      script: [move],
      place: (answer) => {
        placedAnswers.push(answer);
        // Still left out after the round: the rounds ask only once.
        return unplacedPass();
      },
    });
    const result = await run;
    expect(ai.calls).toHaveLength(EDITORIAL_ROUNDS);
    expect(result.rounds).toBe(1);
    expect(placedAnswers[0]!.visuals[0]).toMatchObject({
      from: "w0004",
      to: "w0007",
      description: "a messy desk at night",
    });
    expect(result.notes).toEqual([
      {
        item: "visual-1",
        action: "moved",
        rule: "editorial",
        reason:
          'the editor moved visual 1 to "we cook pasta today" (w0004 to w0007): no room on its sentence',
      },
    ]);
    expect(result.ended).toBeNull();
  });

  it("makes no round when no sentence has room", async () => {
    const { ai, run } = rounds({ script: [move], placed: unplacedPass([]) });
    const result = await run;
    expect(ai.calls).toHaveLength(0);
    expect(result.rounds).toBe(0);
  });

  it("keeps a skip as the stored reason, and the merged answer without the item", async () => {
    const why =
      "No other part of the reel has room for this visual: shorten the sentence before it";
    const { run } = rounds({
      script: [scriptedAnswer({ choices: [{ item: "visuals[0]", skip: true, why }] })],
      place: (merged) => {
        expect(merged.visuals).toEqual([]);
        return placedPass;
      },
    });
    const result = await run;
    expect(result.notes).toEqual([
      {
        item: "visual-1",
        action: "dropped",
        rule: "editorial",
        reason: `the editor left out visual 1: ${why}`,
      },
    ]);
    expect(result.answer.visuals).toEqual([]);
    expect(result.placed).toBe(placedPass);
  });

  it("ends on a refused or broken editorial answer, never retried, keeping the placement before it", async () => {
    const before = unplacedPass();
    for (const script of [
      // The decide answer replayed into the round: not an editorial answer.
      [scriptedAnswer(ANSWER)],
      ["not json"],
    ]) {
      const { ai, run } = rounds({ script, placed: before });
      const result = await run;
      expect(ai.calls).toHaveLength(1);
      expect(result.placed).toBe(before);
      expect(result.answer).toBe(ANSWER);
      expect(result.ended).toMatch(/^the editorial answer was (refused|not valid JSON)/);
    }
    const { run } = rounds({
      script: [move],
      placed: before,
      check: () => ({ ok: false, reasons: ["visuals: at most 2 visuals per reel"] }),
    });
    expect((await run).ended).toBe(
      "the merged answer was refused: visuals: at most 2 visuals per reel",
    );
  });

  it("ends when the AI is not available, never waiting for it", async () => {
    const limit: ScriptedReply = { error: { status: 402 } };
    const result = await rounds({ script: [limit] }).run;
    expect(result.ended).toMatch(/^the AI is not available/);
    expect(result.placed).toEqual(unplacedPass());
  });
});

describe("editorialPrompt", () => {
  it("shows what was left out in words, with no time, pixel or spot, and no photo library", () => {
    const input = editorialInput({
      items: [left()],
      free: FREE,
      transcript,
      preset: ISSEBYA_PRESET,
    });
    const { prompt, promptVersion } = editorialPrompt(EDITORIAL, input);
    expect(promptVersion).toBe("reel-editorial@v1");
    expect(prompt).toContain('"words": "hello there friend"');
    expect(prompt).toContain('"why": "no room on its sentence"');
    expect(prompt).toContain('"text": "we cook pasta today"');
    expect(input).not.toHaveProperty("library");
    expect(prompt).not.toMatch(/\d+\.\d+ s\b/);
    expect(prompt).not.toMatch(/\d\s?px\b/);
    expect(prompt).not.toMatch(/"(top|left|right)"/);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe("runEditorialRounds spans", () => {
  it("traces each round as decide.editorial_round with its number and outcome, the call and the placement under it", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { run } = rounds({
      script: [move],
      telemetry,
      inRound: (name, attributes, work) => inSpan(telemetry, ROOT_CONTEXT, name, attributes, work),
      place: (_answer, context) => {
        // Stands in for the engine's span under the round's context.
        telemetry.tracer.startSpan("decide.engine", {}, context).end();
        return unplacedPass();
      },
    });
    const result = await run;
    expect(result.rounds).toBe(1);
    const spans = exporter.getFinishedSpans();
    const round = spans.find((s) => s.name === "decide.editorial_round");
    expect(round?.attributes).toMatchObject({ "decide.round": 1, "decide.outcome": "placed" });
    const engine = spans.find((s) => s.name === "decide.engine");
    expect(engine?.parentSpanContext?.spanId).toBe(round?.spanContext().spanId);
    // The round's call is a `chat` span under the round, with its own facts.
    const chat = spans.find((s) => s.name === `chat ${AI_MODEL}`);
    expect(chat?.parentSpanContext?.spanId).toBe(round?.spanContext().spanId);
    expect(chat?.kind).toBe(SpanKind.CLIENT);
    expect(chat?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openrouter",
    });
    expect(chat?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(Object.keys(round!.attributes).filter((key) => key.startsWith("ai."))).toEqual([]);
    await telemetry.shutdown();
  });

  it("marks a round the AI cannot answer with error.type and an error status on its chat span", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const unavailable: ScriptedReply = { error: { status: 402 } };
    const { run } = rounds({
      script: [unavailable],
      telemetry,
      inRound: (name, attributes, work) => inSpan(telemetry, ROOT_CONTEXT, name, attributes, work),
    });
    // The automatic run ends its rounds on an unavailable AI; the step goes on.
    expect((await run).ended).toMatch(/the AI is not available/);
    const spans = exporter.getFinishedSpans();
    expect(spans.find((s) => s.name === "decide.editorial_round")?.attributes).toMatchObject({
      "decide.outcome": "unavailable",
    });
    const chat = spans.find((s) => s.name === `chat ${AI_MODEL}`);
    expect(chat?.attributes["error.type"]).toBe("unavailable");
    expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
    await telemetry.shutdown();
  });
});
