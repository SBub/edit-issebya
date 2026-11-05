import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_DECIDE_ANSWER,
  aiRunner,
  aiUnavailableReason,
  fakeAiRunner,
  parseClaudeResult,
  resultEnvelope,
} from "./ai.ts";
import { type ChildRun, type Tool, runToolsStep } from "./step-runner.ts";
import { recordingSteps, stepContext } from "./recording-steps.ts";
import { createTelemetry } from "./telemetry.ts";

// One real `claude -p --output-format json --json-schema` result, ids
// replaced by placeholders (decide/testdata/claude-result.json).
const captured: unknown = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed result
  readFileSync(new URL("./decide/testdata/claude-result.json", import.meta.url), "utf8"),
);
const REQUEST = { prompt: "x", schema: {}, cwd: "/tmp" };
const NEVER: Tool = () => Promise.reject(new Error("the double never spawns"));
// A tool that runs nothing and fails the way a missing binary does.
const MISSING: Tool = (call) => Promise.reject(new Error(`${call.file} exited with 127`));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("aiRunner", () => {
  it("is the double only for exactly 'true', answering an empty decide answer without a script", async () => {
    expect(await aiRunner({ E2E_MOCK_AI: "true" }).call(NEVER, REQUEST)).toMatchObject({
      kind: "answer",
      answer: EMPTY_DECIDE_ANSWER,
    });
  });

  it("is Claude Code otherwise, through the tool, prompt on stdin, no tools", async () => {
    for (const flag of [undefined, "1", "TRUE", " true"]) {
      const runner = aiRunner({ E2E_MOCK_AI: flag, CLAUDE_CODE_PATH: "/nonexistent/claude" });
      await expect(runner.call(MISSING, REQUEST)).rejects.toThrow(/nonexistent\/claude/);
    }
    const seen: Parameters<Tool>[0][] = [];
    const tool: Tool = async (call) => {
      seen.push(call);
      return JSON.stringify(captured);
    };
    await aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(tool, {
      prompt: "the prompt",
      schema: { type: "object" },
      cwd: "/scratch/decide-1",
    });
    expect(seen).toEqual([
      {
        file: "/opt/claude",
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          '{"type":"object"}',
          "--tools",
          "",
          "--no-session-persistence",
        ],
        stdin: "the prompt",
        cwd: "/scratch/decide-1",
        maxStdoutBytes: 16 * 1024 * 1024,
      },
    ]);
  });

  it("lets Claude Code read only the request's one file, with no permission prompts", async () => {
    const seen: Parameters<Tool>[0][] = [];
    const tool: Tool = async (call) => {
      seen.push(call);
      return JSON.stringify(captured);
    };
    await aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(tool, {
      prompt: "describe",
      schema: { type: "object" },
      cwd: "/scratch/describe",
      readFile: "photo.jpg",
    });
    expect(seen[0]?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      '{"type":"object"}',
      "--tools",
      "Read",
      "--allowedTools",
      "Read(photo.jpg)",
      "--permission-prompts",
      "none",
      "--no-session-persistence",
    ]);
    expect(seen[0]?.cwd).toBe("/scratch/describe");
  });

  it("refuses a readFile that is not a plain file name, before spawning", async () => {
    for (const readFile of [
      "../photo.jpg",
      "a/photo.jpg",
      "/etc/passwd",
      "..",
      "",
      "*.jpg",
      "a..b",
    ]) {
      await expect(
        aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(NEVER, { ...REQUEST, readFile }),
      ).rejects.toThrow(/plain file name/);
      await expect(
        fakeAiRunner([resultEnvelope({})]).call(NEVER, { ...REQUEST, readFile }),
      ).rejects.toThrow(/plain file name/);
    }
  });

  it("asks for the request's model with --model, and for none without one", async () => {
    const seen: Parameters<Tool>[0][] = [];
    const tool: Tool = async (call) => {
      seen.push(call);
      return JSON.stringify(captured);
    };
    const runner = aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" });
    await runner.call(tool, { ...REQUEST, model: "claude-haiku-5-5" });
    await runner.call(tool, REQUEST);
    expect(seen[0]?.args.slice(-3)).toEqual([
      "--model",
      "claude-haiku-5-5",
      "--no-session-persistence",
    ]);
    expect(seen[1]?.args).not.toContain("--model");
    const fake = fakeAiRunner([resultEnvelope({})]);
    await fake.call(NEVER, { ...REQUEST, model: "claude-haiku-5-5" });
    expect(fake.calls[0]?.model).toBe("claude-haiku-5-5");
  });

  it("refuses a model that is not a plain model id, before spawning", async () => {
    for (const model of ["claude haiku", 'claude"', "--help", "", "Claude-Haiku"]) {
      await expect(
        aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(NEVER, { ...REQUEST, model }),
      ).rejects.toThrow(/plain model id/);
      await expect(
        fakeAiRunner([resultEnvelope({})]).call(NEVER, { ...REQUEST, model }),
      ).rejects.toThrow(/plain model id/);
    }
  });

  it("replays E2E_MOCK_AI_SCRIPT, raw strings included, then the last entry", async () => {
    const path = join(dir, "script.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's temp folder
    await writeFile(path, JSON.stringify(["not json", resultEnvelope({ n: 2 })]));
    const runner = aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: path });
    const results = [
      await runner.call(NEVER, REQUEST),
      await runner.call(NEVER, REQUEST),
      await runner.call(NEVER, REQUEST),
    ];
    expect(results.map((result) => result.kind)).toEqual(["broken", "answer", "answer"]);
    expect(results[2]).toMatchObject({ answer: { n: 2 } });
  });

  it("loads the committed decide answer, one envelope, as a one-entry script", async () => {
    const path = fileURLToPath(
      new URL("./decide/testdata/short-speech-answer.json", import.meta.url),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed answer
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { structured_output: unknown };
    const runner = aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: path });
    for (let i = 0; i < 2; i += 1) {
      expect(await runner.call(NEVER, REQUEST)).toMatchObject({
        kind: "answer",
        answer: envelope.structured_output,
        usage: {
          inputTokens: 1500,
          outputTokens: 456,
          costUsd: 0.0123,
          model: "claude-opus-5-5",
        },
      });
    }
  });

  it("throws on a missing or malformed script file", async () => {
    expect(() =>
      aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: join(dir, "missing.json") }),
    ).toThrow(/E2E_MOCK_AI_SCRIPT .* cannot be read/);
    for (const [name, text, message] of [
      [
        "empty.json",
        "[]",
        /E2E_MOCK_AI_SCRIPT .* must be a non-empty JSON array or one result envelope/,
      ],
      [
        "string.json",
        '"text"',
        /E2E_MOCK_AI_SCRIPT .* must be a non-empty JSON array or one result envelope/,
      ],
      ["broken.json", "not json", /E2E_MOCK_AI_SCRIPT .* is not JSON/],
    ] as const) {
      const path = join(dir, name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's temp folder
      await writeFile(path, text);
      expect(() => aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: path })).toThrow(message);
    }
  });
});

describe("fakeAiRunner", () => {
  it("records every request", async () => {
    const runner = fakeAiRunner([resultEnvelope(1)]);
    await runner.call(NEVER, { ...REQUEST, prompt: "a" });
    await runner.call(NEVER, { ...REQUEST, prompt: "b" });
    expect(runner.calls.map((call) => call.prompt)).toEqual(["a", "b"]);
  });
});

describe("parseClaudeResult", () => {
  it("reads the captured real result: answer, every input token, output, cost and model", () => {
    expect(parseClaudeResult(JSON.stringify(captured))).toEqual({
      kind: "answer",
      answer: { ok: true },
      usage: {
        inputTokens: 2 + 145193 + 0,
        outputTokens: 52,
        costUsd: 1.1625919999999998,
        model: "claude-opus-5-5",
        cacheReadTokens: 0,
        cacheWriteTokens: 145193,
      },
    });
  });

  it("falls back to parsing result", () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: '{"ok":true}' }))).toEqual({
      kind: "answer",
      answer: { ok: true },
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        model: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
  });

  it("is broken on stdout that is not JSON", () => {
    expect(parseClaudeResult("not json")).toMatchObject({ kind: "broken" });
  });

  it("is broken on an error envelope, keeping its usage", () => {
    const result = parseClaudeResult(
      JSON.stringify({ is_error: true, result: "quota", total_cost_usd: 0.5 }),
    );
    expect(result).toMatchObject({ kind: "broken", usage: { costUsd: 0.5 } });
    expect(result.kind === "broken" && result.reason).toMatch(/quota/);
  });

  it("is broken without structured_output or a JSON result", () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: false }))).toMatchObject({
      kind: "broken",
    });
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: "hi" }))).toMatchObject({
      kind: "broken",
    });
  });
});

function testdata(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed fixture
  return readFileSync(new URL(`./decide/testdata/${name}`, import.meta.url), "utf8");
}

describe("an AI that is not available", () => {
  it("parses the usage-limit and signed-out envelopes as unavailable", () => {
    expect(parseClaudeResult(testdata("claude-usage-limit.json"))).toMatchObject({
      kind: "unavailable",
      reason: "the usage limit is reached",
    });
    expect(parseClaudeResult(testdata("claude-signed-out.json"))).toMatchObject({
      kind: "unavailable",
      reason: "Claude Code is signed out",
    });
  });

  it("keeps an unrelated error envelope broken", () => {
    expect(
      parseClaudeResult(JSON.stringify({ is_error: true, result: "the model overloaded" })),
    ).toMatchObject({ kind: "broken" });
  });

  it("maps the known texts to a reason", () => {
    expect(aiUnavailableReason("You've hit your limit, resets 5pm")).toBe(
      "the usage limit is reached",
    );
    expect(aiUnavailableReason("Not logged in")).toBe("Claude Code is signed out");
    expect(aiUnavailableReason("OAuth token has expired")).toBe("Claude Code is signed out");
    expect(aiUnavailableReason("authentication_error")).toBe("Claude Code is signed out");
    expect(aiUnavailableReason("Error: ECONNRESET")).toBeNull();
  });

  it("turns Claude Code's non-zero exit with the signed-out output into unavailable", async () => {
    const stdout = testdata("claude-signed-out-stdout.txt");
    const failing: Tool = (call) =>
      Promise.reject(new Error(`decide exited with 1\n${stdout}`, { cause: call.file }));
    expect(await aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(failing, REQUEST)).toEqual({
      kind: "unavailable",
      reason: "Claude Code is signed out",
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        model: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
  });

  it("rethrows any other non-zero exit", async () => {
    const failing: Tool = () => Promise.reject(new Error("decide exited with 1\nsegfault"));
    await expect(
      aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(failing, REQUEST),
    ).rejects.toThrow("segfault");
  });

  it("is replayed by the double from the usage-limit fixture", async () => {
    const runner = fakeAiRunner([JSON.parse(testdata("claude-usage-limit.json"))]);
    expect(await runner.call(NEVER, REQUEST)).toMatchObject({ kind: "unavailable" });
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
  it("is one CLIENT span under the parent, named with the request model, with the GenAI attributes", async () => {
    const { trace: traced, finish } = tracing();
    const tool: Tool = async () => JSON.stringify(captured);
    const result = await aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(tool, {
      ...REQUEST,
      model: "claude-haiku-5-5",
      trace: traced,
    });
    expect(result).toMatchObject({ kind: "answer" });
    const { spans, parent } = await finish();
    const chat = spans.find((span) => span.name === "chat claude-haiku-5-5");
    expect(chat?.kind).toBe(SpanKind.CLIENT);
    expect(chat?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    // The captured envelope: 2 fresh input tokens, 145193 cache writes, no
    // cache reads (so none is recorded), 52 output tokens, its cost as reported.
    expect(chat?.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-haiku-5-5",
      "gen_ai.response.model": "claude-opus-5-5",
      "gen_ai.usage.input_tokens": 2 + 145193,
      "gen_ai.usage.output_tokens": 52,
      "gen_ai.usage.cache_write.input_tokens": 145193,
      "edit_issebya.ai.cost_usd": 1.1625919999999998,
      "edit_issebya.claude.duration_ms": 5207,
      "edit_issebya.claude.duration_api_ms": 4999,
      "edit_issebya.claude.num_turns": 2,
      "edit_issebya.claude.overhead_ms": 208,
    });
    expect(chat?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("counts cache reads and writes into the input tokens, and names the call chat without a request model", async () => {
    const { trace: traced, finish } = tracing();
    const envelope = {
      ...resultEnvelope({ ok: true }),
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 60,
        cache_read_input_tokens: 30,
        output_tokens: 5,
      },
      modelUsage: { "claude-opus-5-5": { outputTokens: 5 } },
    };
    await fakeAiRunner([envelope]).call(NEVER, { ...REQUEST, trace: traced });
    const { spans } = await finish();
    const chat = spans.find((span) => span.name === "chat");
    expect(chat?.attributes).toMatchObject({
      "gen_ai.response.model": "claude-opus-5-5",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 30,
      "gen_ai.usage.cache_write.input_tokens": 60,
    });
    expect(chat?.attributes).not.toHaveProperty("gen_ai.request.model");
    // The envelope reports a cost of 0, which is a reported value and kept.
    expect(chat?.attributes["edit_issebya.ai.cost_usd"]).toBe(0);
  });

  it("marks a broken answer as an error with error.type broken", async () => {
    const { trace: traced, finish } = tracing();
    await fakeAiRunner(["not json"]).call(NEVER, { ...REQUEST, trace: traced });
    const { spans } = await finish();
    const chat = spans.find((span) => span.name === "chat");
    expect(chat?.attributes["error.type"]).toBe("broken");
    expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("marks a thrown call as an error with error.type broken, records it and rethrows it", async () => {
    const { trace: traced, finish } = tracing();
    const failing: Tool = () => Promise.reject(new Error("decide exited with 1\nsegfault"));
    await expect(
      aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(failing, { ...REQUEST, trace: traced }),
    ).rejects.toThrow("segfault");
    const { spans } = await finish();
    const chat = spans.find((span) => span.name === "chat");
    expect(chat?.attributes["error.type"]).toBe("broken");
    expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
    expect(chat?.events.map((event) => event.name)).toEqual(["exception"]);
  });

  it("marks an unavailable call with error.type unavailable and an error status", async () => {
    const { trace: traced, finish } = tracing();
    const stdout = testdata("claude-signed-out-stdout.txt");
    const failing: Tool = () => Promise.reject(new Error(`decide exited with 1\n${stdout}`));
    const result = await aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(failing, {
      ...REQUEST,
      trace: traced,
    });
    expect(result).toMatchObject({ kind: "unavailable" });
    const { spans } = await finish();
    const chat = spans.find((span) => span.name === "chat");
    expect(chat?.attributes["error.type"]).toBe("unavailable");
    expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("runs Claude Code as an exec span under the chat span, in the step's trace", async () => {
    const { trace: traced, finish } = tracing();
    const { steps } = recordingSteps();
    const answer: ChildRun = {
      code: 0,
      exitSignal: null,
      report: "",
      output: "",
      stdout: JSON.stringify(captured),
      groupPeakBytes: null,
    };
    await runToolsStep(
      stepContext(steps, { telemetry: traced.telemetry }),
      {
        name: "decide",
        async work(tool) {
          await aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" }).call(tool, {
            ...REQUEST,
            model: "claude-haiku-5-5",
            trace: traced,
          });
          return { what: "decided" };
        },
      },
      () => Promise.resolve(answer),
    );
    const { spans } = await finish();
    const chat = spans.find((span) => span.name === "chat claude-haiku-5-5");
    const exec = spans.find((span) => span.name === "exec claude");
    expect(exec?.parentSpanContext?.spanId).toBe(chat?.spanContext().spanId);
    expect(exec?.attributes).toMatchObject({
      "step.name": "decide",
      "process.executable.name": "claude",
      "process.exit.code": 0,
    });
  });

  it("carries Claude Code's own timings from the captured result, and the overhead", async () => {
    const { trace: traced, finish } = tracing();
    await fakeAiRunner([captured]).call(NEVER, { ...REQUEST, trace: traced });
    const { spans } = await finish();
    const chat = spans.find((span) => span.name === "chat");
    expect(chat?.attributes).toMatchObject({
      "edit_issebya.claude.duration_ms": 5207,
      "edit_issebya.claude.duration_api_ms": 4999,
      "edit_issebya.claude.num_turns": 2,
      "edit_issebya.claude.overhead_ms": 208,
    });
  });

  it("carries the timings of an unavailable result too (the signed-out envelope)", async () => {
    const { trace: traced, finish } = tracing();
    await fakeAiRunner([JSON.parse(testdata("claude-signed-out.json"))]).call(NEVER, {
      ...REQUEST,
      trace: traced,
    });
    const { spans } = await finish();
    const chat = spans.find((span) => span.name === "chat");
    expect(chat?.attributes).toMatchObject({
      "error.type": "unavailable",
      "edit_issebya.claude.duration_ms": 412,
      "edit_issebya.claude.duration_api_ms": 0,
      "edit_issebya.claude.num_turns": 1,
      "edit_issebya.claude.overhead_ms": 412,
    });
  });

  it("leaves out each timing the JSON lacks, and the overhead unless both are there and it is not negative", async () => {
    const { trace: traced, finish } = tracing();
    const runner = fakeAiRunner([
      { ...resultEnvelope({ ok: true }), duration_ms: 300 },
      { ...resultEnvelope({ ok: true }), duration_ms: 100, duration_api_ms: 250 },
      {
        ...resultEnvelope({ ok: true }),
        duration_ms: "fast",
        duration_api_ms: 50,
        num_turns: null,
      },
    ]);
    for (let i = 0; i < 3; i += 1) await runner.call(NEVER, { ...REQUEST, trace: traced });
    const { spans } = await finish();
    const [first, second, third] = spans.filter((span) => span.name === "chat");
    expect(first?.attributes).toEqual(
      expect.objectContaining({ "edit_issebya.claude.duration_ms": 300 }),
    );
    for (const name of [
      "edit_issebya.claude.duration_api_ms",
      "edit_issebya.claude.num_turns",
      "edit_issebya.claude.overhead_ms",
    ]) {
      expect(first?.attributes).not.toHaveProperty(name);
    }
    expect(second?.attributes).toMatchObject({
      "edit_issebya.claude.duration_ms": 100,
      "edit_issebya.claude.duration_api_ms": 250,
    });
    expect(second?.attributes).not.toHaveProperty("edit_issebya.claude.overhead_ms");
    expect(third?.attributes).toMatchObject({ "edit_issebya.claude.duration_api_ms": 50 });
    expect(third?.attributes).not.toHaveProperty("edit_issebya.claude.duration_ms");
    expect(third?.attributes).not.toHaveProperty("edit_issebya.claude.num_turns");
    expect(third?.attributes).not.toHaveProperty("edit_issebya.claude.overhead_ms");
  });

  it("changes nothing untraced: the same result as the parser, and no span", async () => {
    const { finish } = tracing();
    const result = await fakeAiRunner([captured]).call(NEVER, REQUEST);
    expect(result).toEqual(parseClaudeResult(JSON.stringify(captured)));
    const { spans } = await finish();
    expect(spans.map((span) => span.name)).toEqual(["decide.test"]);
  });

  it("is not made without a parent: the call runs, returns its answer, and starts no span", async () => {
    const { finish } = tracing();
    const result = await fakeAiRunner([resultEnvelope({ ok: true })]).call(NEVER, REQUEST);
    expect(result).toMatchObject({ kind: "answer", answer: { ok: true } });
    // Only the test's own parent span ended.
    const { spans } = await finish();
    expect(spans.map((span) => span.name)).toEqual(["decide.test"]);
  });
});
