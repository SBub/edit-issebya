import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AI_MODEL,
  AI_MODELS,
  type AiRequest,
  EMPTY_DECIDE_ANSWER,
  aiRunner,
  aiUnavailableReason,
  extractJson,
  fakeAiRunner,
  listPriceUsd,
  modelRunner,
  openRouterRunner,
  scriptedAnswer,
  wireSchema,
} from "./ai.ts";
import { createTelemetry } from "./telemetry.ts";

const SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { a: { type: "string", maxLength: 3 } },
  required: ["a"],
  additionalProperties: false,
};
const REQUEST: AiRequest = {
  role: "decide",
  prompt: "x",
  promptVersion: "test-prompt@v1",
  schema: SCHEMA,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the model", () => {
  it("is Claude Haiku 5.5 on OpenRouter for every role, the judge included", () => {
    expect(AI_MODEL).toBe("anthropic/claude-haiku-5.5");
    expect(Object.keys(AI_MODELS).sort()).toEqual(["decide", "describe", "hook", "judge"]);
    expect(new Set(Object.values(AI_MODELS))).toEqual(new Set([AI_MODEL]));
  });

  it("is priced at 0.10 and 0.50 dollars per million tokens when OpenRouter reports no cost", () => {
    expect(listPriceUsd(AI_MODEL, 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(listPriceUsd(AI_MODEL, 2000, 100)).toBeCloseTo(0.00025);
    expect(listPriceUsd("other/model", 10, 10)).toBeNull();
    expect(listPriceUsd(AI_MODEL, null, null)).toBeNull();
  });
});

describe("wireSchema", () => {
  it("leaves out $schema and the constraints strict outputs refuse, never a property's name", () => {
    expect(
      wireSchema({
        $schema: "draft-07",
        type: "object",
        properties: {
          maxLength: { type: "string", minLength: 1, maxLength: 60, pattern: "^a$" },
          list: { type: "array", items: { enum: ["x"] }, minItems: 3, maxItems: 12 },
          one: { type: "array", minItems: 1 },
          n: { type: "number", minimum: 0, maximum: 9 },
        },
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        maxLength: { type: "string", pattern: "^a$" },
        list: { type: "array", items: { enum: ["x"] } },
        one: { type: "array", minItems: 1 },
        n: { type: "number" },
      },
      additionalProperties: false,
    });
  });
});

describe("the OpenRouter request", () => {
  // The real provider over a captured fetch: what would go on the wire, and
  // OpenRouter's response read back. No network.
  function capturing(response: object) {
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const openrouter = createOpenRouter({
      apiKey: "test-key",
      fetch: fetch as typeof globalThis.fetch,
    });
    const runner = modelRunner({
      model: (id) =>
        openrouter(id, { usage: { include: true }, provider: { require_parameters: true } }),
    });
    return { runner, bodies, urls };
  }

  const ANSWERED = {
    id: "gen-1",
    model: "anthropic/claude-haiku-5.5",
    created: 1,
    choices: [
      { index: 0, message: { role: "assistant", content: '{"a":"z"}' }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, cost: 0.0042 },
  };

  it("asks for the strict JSON Schema, usage accounting and providers that take every parameter", async () => {
    const { runner, bodies, urls } = capturing(ANSWERED);
    const result = await runner.call(REQUEST);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
    expect(bodies[0]).toMatchObject({
      model: "anthropic/claude-haiku-5.5",
      response_format: {
        type: "json_schema",
        json_schema: { name: "decide", strict: true, schema: wireSchema(SCHEMA) },
      },
      messages: [{ role: "user", content: "x" }],
      usage: { include: true },
      provider: { require_parameters: true },
    });
    // Our prompt only: no system message.
    expect(JSON.stringify(bodies[0]!.messages)).not.toContain('"system"');
    // The tokens and the cost OpenRouter reported, the model that answered.
    expect(result).toMatchObject({
      kind: "answer",
      answer: { a: "z" },
      usage: { inputTokens: 100, outputTokens: 7, costUsd: 0.0042, model: AI_MODEL },
    });
  });

  it("sends no temperature: the request the model receives carries none, and the exchange records the prompt's identity only", async () => {
    const { runner, bodies } = capturing(ANSWERED);
    const result = await runner.call(REQUEST);
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(result.exchange).toMatchObject({ promptVersion: "test-prompt@v1" });
    expect(result.exchange).not.toHaveProperty("temperature");
  });

  it("records a stale prompt copy on the exchange, and leaves the flag off a fresh one", async () => {
    const { runner } = capturing(ANSWERED);
    const stale = await runner.call({ ...REQUEST, promptStale: true });
    expect(stale.exchange).toMatchObject({ promptVersion: "test-prompt@v1", promptStale: true });
    const fresh = await runner.call(REQUEST);
    expect(fresh.exchange).not.toHaveProperty("promptStale");
  });

  it("sends describe_photo's image as a JPEG data URL beside the prompt", async () => {
    const { runner, bodies } = capturing(ANSWERED);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const result = await runner.call({
      role: "describe",
      prompt: "describe it",
      promptVersion: "test-prompt@v1",
      schema: SCHEMA,
      image: { data: jpeg, mediaType: "image/jpeg" },
    });
    expect(bodies[0]!.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe it" },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` },
          },
        ],
      },
    ]);
    // The record names the image, never carries its bytes.
    expect(result.exchange.image).toEqual({ mediaType: "image/jpeg", bytes: 4 });
  });

  it("computes the cost from the list price when the response has none", async () => {
    const { runner } = capturing({
      ...ANSWERED,
      usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 },
    });
    const result = await runner.call(REQUEST);
    expect(result.usage.costUsd).toBeCloseTo(0.00025);
  });
});

describe("aiRunner", () => {
  it("is the double only for exactly 'true', answering an empty decide answer without a script", async () => {
    const result = await aiRunner({ E2E_MOCK_AI: "true" }).call(REQUEST);
    expect(result).toMatchObject({ kind: "answer", answer: EMPTY_DECIDE_ANSWER });
  });

  it("is OpenRouter otherwise: without a key every call is unavailable and nothing is sent", async () => {
    for (const env of [{}, { E2E_MOCK_AI: "1", OPENROUTER_API_KEY: "  " }]) {
      const result = await aiRunner(env).call(REQUEST);
      expect(result).toMatchObject({
        kind: "unavailable",
        reason: "the OpenRouter key is not set",
      });
    }
    expect(await openRouterRunner(undefined).call(REQUEST)).toMatchObject({
      kind: "unavailable",
    });
  });

  it("replays E2E_MOCK_AI_SCRIPT, raw strings included, then the last entry", async () => {
    const path = join(dir, "script.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder or committed fixture
    await writeFile(path, JSON.stringify(["not json", scriptedAnswer({ a: "b" })]));
    const runner = aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: path });
    expect(await runner.call(REQUEST)).toMatchObject({ kind: "broken" });
    expect(await runner.call(REQUEST)).toMatchObject({ kind: "answer", answer: { a: "b" } });
    expect(await runner.call(REQUEST)).toMatchObject({ kind: "answer", answer: { a: "b" } });
  });

  it("loads the committed script: the hook reply for hook calls, the decide answer for the rest", async () => {
    const path = new URL("./decide/testdata/short-speech-answer.json", import.meta.url).pathname;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder or committed fixture
    const committed = JSON.parse(await readFile(path, "utf8")) as {
      role?: string;
      answer: unknown;
    }[];
    const runner = aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: path });
    const decide = await runner.call(REQUEST);
    expect(decide).toMatchObject({
      kind: "answer",
      answer: committed.find((reply) => reply.role !== "hook")!.answer,
      usage: { inputTokens: 1500, outputTokens: 456, costUsd: 0.0123, model: AI_MODEL },
    });
    const hook = await runner.call({ ...REQUEST, role: "hook" });
    expect(hook).toMatchObject({
      kind: "answer",
      answer: { text: "A short test for the real studio" },
      usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.0015, model: AI_MODEL },
    });
  });

  it("throws on a missing or malformed script file", async () => {
    const missing = join(dir, "missing.json");
    expect(() => aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: missing })).toThrow(
      /cannot be read/,
    );
    const bad = join(dir, "bad.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder or committed fixture
    await writeFile(bad, "{");
    expect(() => aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: bad })).toThrow(/not JSON/);
    const empty = join(dir, "empty.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder or committed fixture
    await writeFile(empty, "[]");
    expect(() => aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: empty })).toThrow(
      /non-empty JSON array/,
    );
  });
});

describe("extractJson", () => {
  it("strips a code fence with or without a language tag", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('  ```\n{"a":1}\n```  \n')).toBe('{"a":1}');
    expect(extractJson('```JSON {"a":1} ```')).toBe('{"a":1}');
  });

  it("takes the outermost object out of leading or trailing prose", () => {
    expect(extractJson('Here it is: {"a":{"b":1}}')).toBe('{"a":{"b":1}}');
    expect(extractJson('{"a":[1]}\nHope this helps.')).toBe('{"a":[1]}');
    expect(extractJson('Sure:\n```json\n{"a":1}\n```\nDone.')).toBe('{"a":1}');
  });

  it("leaves plain JSON as it is", () => {
    expect(extractJson('{"a":"b"}')).toBe('{"a":"b"}');
  });

  it("leaves text with no object to fail parsing", () => {
    for (const text of ["not json", "```json\nnot json\n```", "} nothing {", "{ not json }"]) {
      expect(() => JSON.parse(extractJson(text))).toThrow();
    }
  });
});

describe("fakeAiRunner", () => {
  const HOOK: AiRequest = { ...REQUEST, role: "hook" };

  it("answers the hook calls from the replies naming the hook role, the rest from the others", async () => {
    const runner = fakeAiRunner([
      { role: "hook", answer: { text: "A hook" } },
      { answer: { a: "b" } },
      { role: "hook", answer: { text: "Another" } },
    ]);
    expect(await runner.call(HOOK)).toMatchObject({ kind: "answer", answer: { text: "A hook" } });
    expect(await runner.call(REQUEST)).toMatchObject({ kind: "answer", answer: { a: "b" } });
    // The hook lane's last reply repeats for the next hook call.
    expect(await runner.call(HOOK)).toMatchObject({ kind: "answer", answer: { text: "Another" } });
    expect(await runner.call(HOOK)).toMatchObject({ kind: "answer", answer: { text: "Another" } });
    expect(await runner.call(REQUEST)).toMatchObject({ kind: "answer", answer: { a: "b" } });
  });

  it("has no scripted hook answer when the script names none for the hook role", async () => {
    const runner = fakeAiRunner([{ answer: { a: "b" } }]);
    await expect(runner.call(HOOK)).rejects.toThrow(/no scripted hook answer/);
  });

  it("records every request and its exchange: prompt, schema, raw answer and usage", async () => {
    const runner = fakeAiRunner([
      { answer: { a: "b" }, usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.5 } },
    ]);
    const result = await runner.call(REQUEST);
    expect(runner.calls).toEqual([REQUEST]);
    expect(result.exchange).toEqual({
      role: "decide",
      model: AI_MODEL,
      prompt: "x",
      promptVersion: "test-prompt@v1",
      schema: SCHEMA,
      image: null,
      outputMode: "json_schema",
      answerText: '{"a":"b"}',
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        costUsd: 0.5,
        model: AI_MODEL,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
      error: null,
    });
  });

  it("is broken on text that is not JSON, keeping the raw text", async () => {
    const result = await fakeAiRunner(["not json"]).call(REQUEST);
    expect(result).toMatchObject({ kind: "broken", reason: /^the answer is not JSON/ });
    expect(result.exchange.answerText).toBe("not json");
  });

  it("never validates the answer itself: the caller's Zod check does", async () => {
    const result = await fakeAiRunner([scriptedAnswer({ a: "far too long", extra: 1 })]).call(
      REQUEST,
    );
    expect(result).toMatchObject({ kind: "answer", answer: { a: "far too long", extra: 1 } });
  });

  it("asks again once in JSON mode, the schema in the prompt, when the schema is refused", async () => {
    const runner = fakeAiRunner([
      { error: { status: 400, message: "schema not supported" } },
      scriptedAnswer({ a: "b" }),
    ]);
    const result = await runner.call(REQUEST);
    expect(result).toMatchObject({ kind: "answer", answer: { a: "b" } });
    expect(result.exchange.outputMode).toBe("json");
    expect(result.exchange.prompt).toContain("matching this JSON Schema");
    expect(result.exchange.prompt).toContain(JSON.stringify(wireSchema(SCHEMA)));
    expect(runner.calls).toHaveLength(1);
  });

  it("asks for the object only, with no code fence, in JSON mode", async () => {
    const runner = fakeAiRunner([{ error: { status: 400 } }, scriptedAnswer({ a: "b" })]);
    const result = await runner.call(REQUEST);
    expect(result.exchange.prompt).toContain(
      "Reply with the JSON object only, no code fence around it.",
    );
  });

  it("parses a fenced JSON mode answer, keeping the raw text in the exchange", async () => {
    const fenced = '```json\n{"a":"b"}\n```';
    const runner = fakeAiRunner([{ error: { status: 400 } }, fenced]);
    const result = await runner.call(REQUEST);
    expect(result).toMatchObject({ kind: "answer", answer: { a: "b" } });
    expect(result.exchange).toMatchObject({ outputMode: "json", answerText: fenced, error: null });
  });

  it("is broken on a JSON mode answer with no JSON in it, keeping the raw text", async () => {
    const runner = fakeAiRunner([{ error: { status: 400 } }, "```json\nnot json\n```"]);
    const result = await runner.call(REQUEST);
    expect(result).toMatchObject({ kind: "broken", reason: /^the answer is not JSON/ });
    expect(result.exchange.answerText).toBe("```json\nnot json\n```");
  });

  it("never extracts from a strict JSON Schema answer", async () => {
    const result = await fakeAiRunner(['```json\n{"a":"b"}\n```']).call(REQUEST);
    expect(result).toMatchObject({ kind: "broken", reason: /^the answer is not JSON/ });
  });

  it("throws a bad request that JSON mode does not fix either", async () => {
    const runner = fakeAiRunner([{ error: { status: 400, message: "bad request" } }]);
    await expect(runner.call(REQUEST)).rejects.toThrow(/bad request/);
  });

  it("throws without a script", async () => {
    await expect(fakeAiRunner([]).call(REQUEST)).rejects.toThrow(/no scripted answer/);
  });
});

describe("an AI that is not available", () => {
  it("maps a refused key, used-up credits, a rate limit and a server error to a reason", async () => {
    const cases: [number, string][] = [
      [401, "the OpenRouter key is refused"],
      [403, "the OpenRouter key is refused"],
      [402, "the OpenRouter credits are used up"],
      [429, "the rate limit is reached"],
      [502, "OpenRouter is not answering"],
      [408, "OpenRouter is not answering"],
    ];
    for (const [status, reason] of cases) {
      const result = await fakeAiRunner([{ error: { status } }]).call(REQUEST);
      expect(result).toMatchObject({ kind: "unavailable", reason });
      expect(result.exchange.error).toBe(reason);
    }
  });

  it("is replayed by the double from the credits fixture", async () => {
    const path = new URL("./decide/testdata/ai-credits-used-up.json", import.meta.url).pathname;
    const result = await aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: path }).call(REQUEST);
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "the OpenRouter credits are used up",
    });
  });

  it("reads a network failure or a timeout as not answering, anything else as no reason", () => {
    expect(aiUnavailableReason(new TypeError("fetch failed"))).toBe("OpenRouter is not answering");
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(aiUnavailableReason(timeout)).toBe("OpenRouter is not answering");
    expect(aiUnavailableReason(new Error("boom"))).toBeNull();
  });

  it("rethrows when the job's own signal stopped the call", async () => {
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));
    await expect(
      fakeAiRunner([scriptedAnswer({ a: "b" })]).call({ ...REQUEST, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

// A parent span under test, its telemetry, and the trace option that puts a
// call's `chat` span under that parent. `finish` ends the parent and returns
// every span that ended.
function tracing() {
  const exporter = new InMemorySpanExporter();
  const telemetry = createTelemetry(
    {},
    { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
  );
  const parent = telemetry.tracer.startSpan("decide.test");
  const parentContext = trace.setSpan(ROOT_CONTEXT, parent);
  return {
    trace: { telemetry, parent: parentContext },
    async finish() {
      parent.end();
      const spans = exporter.getFinishedSpans();
      await telemetry.shutdown();
      return { spans, parent };
    },
  };
}

describe("the chat span of a call", () => {
  it("is one CLIENT span under the parent, named with the model, with the GenAI attributes", async () => {
    const { trace: traced, finish } = tracing();
    const result = await fakeAiRunner([
      { answer: { a: "b" }, usage: { input_tokens: 100, output_tokens: 5, cost_usd: 0.001 } },
    ]).call({ ...REQUEST, trace: traced });
    expect(result).toMatchObject({ kind: "answer" });
    const { spans, parent } = await finish();
    expect(spans.map((span) => span.name)).toEqual([`chat ${AI_MODEL}`, "decide.test"]);
    const chat = spans[0]!;
    expect(chat.kind).toBe(SpanKind.CLIENT);
    expect(chat.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(chat.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openrouter",
      "gen_ai.request.model": AI_MODEL,
      "edit_issebya.ai.prompt_version": "test-prompt@v1",
      "gen_ai.response.model": AI_MODEL,
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.response.finish_reasons": ["stop"],
      "edit_issebya.ai.role": "decide",
      "edit_issebya.ai.output_mode": "json_schema",
      "edit_issebya.ai.cost_usd": 0.001,
    });
    expect(chat.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("marks a broken answer and an unavailable AI as errors with their error.type", async () => {
    for (const [reply, type] of [
      ["not json", "broken"],
      [{ error: { status: 402 } }, "unavailable"],
    ] as const) {
      const { trace: traced, finish } = tracing();
      await fakeAiRunner([reply]).call({ ...REQUEST, trace: traced });
      const { spans } = await finish();
      const chat = spans.find((span) => span.name.startsWith("chat"));
      expect(chat?.attributes["error.type"]).toBe(type);
      expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
    }
  });

  it("marks a thrown call as broken, records it and rethrows it", async () => {
    const { trace: traced, finish } = tracing();
    await expect(
      fakeAiRunner([{ error: { status: 400 } }]).call({ ...REQUEST, trace: traced }),
    ).rejects.toThrow();
    const { spans } = await finish();
    const chat = spans.find((span) => span.name.startsWith("chat"));
    expect(chat?.attributes["error.type"]).toBe("broken");
    expect(chat?.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("is not made without a trace: the call runs and starts no span", async () => {
    const result = await fakeAiRunner([scriptedAnswer({ a: "b" })]).call(REQUEST);
    expect(result).toMatchObject({ kind: "answer" });
  });
});
