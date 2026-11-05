import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Attributes, type Context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tool } from "./step-runner.ts";
import type { AiUsage } from "./step-store.ts";
import type { Telemetry } from "./telemetry.ts";

type Env = Record<string, string | undefined>;

// One structured call: the prompt (on stdin), the JSON Schema the answer must
// match, and the folder Claude Code runs in.
export interface AiRequest {
  prompt: string;
  schema: object;
  cwd: string;
  // The one file inside `cwd` Claude Code may read (a plain file name, the
  // describe_photo step's image); without it Claude Code has no tools at all.
  readFile?: string;
  // The model to answer with (`--model`); without it Claude Code's default.
  model?: string;
  // The span this call's `chat` span is a child of, and the telemetry it is
  // recorded with. Without it the call is not traced.
  trace?: { telemetry: Telemetry; parent: Context };
}

// A plain file name: no folder, no `..`, nothing a shell or a permission rule
// could read as more than one file.
const READ_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// A model id: lower-case letters, digits, dots and dashes, nothing else.
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;

// The model flag of one call: none, or `--model` with a checked id.
function modelArgs(model: string | undefined): string[] {
  if (model === undefined) return [];
  if (!MODEL.test(model)) throw new Error(`ai: model must be a plain model id: ${model}`);
  return ["--model", model];
}

// The tool flags of one call: none at all, or only Read on the one file.
function toolArgs(readFile: string | undefined): string[] {
  if (readFile === undefined) return ["--tools", ""];
  if (!READ_FILE.test(readFile) || readFile.includes("..")) {
    throw new Error(`ai: readFile must be a plain file name inside cwd: ${readFile}`);
  }
  return ["--tools", "Read", "--allowedTools", `Read(${readFile})`, "--permission-prompts", "none"];
}

export type AiResult =
  | { kind: "answer"; answer: unknown; usage: AiUsage }
  | { kind: "broken"; reason: string; usage: AiUsage }
  // Claude Code cannot answer now (a usage limit, signed out): the job waits.
  | { kind: "unavailable"; reason: string; usage: AiUsage };

export interface AiRunner {
  // Runs through `tool`, so a step measures the call like any other tool.
  call(tool: Tool, request: AiRequest): Promise<AiResult>;
}

const NO_USAGE: AiUsage = {
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  model: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Every input token Claude Code reports (fresh, cache writes, cache reads),
// the output tokens, the cost as reported, the model that wrote the most
// output, and the two cache counts apart. Raw numbers, never converted; null
// where a field is missing.
function usageOf(envelope: Record<string, unknown>): AiUsage {
  const usage = (envelope.usage ?? {}) as Record<string, unknown>;
  const inputs = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].map(count);
  const known = inputs.filter((value) => value !== null);
  const models = Object.entries((envelope.modelUsage ?? {}) as Record<string, unknown>).map(
    ([name, entry]) => ({
      name,
      output: count((entry as Record<string, unknown> | null)?.outputTokens) ?? 0,
    }),
  );
  models.sort((a, b) => b.output - a.output);
  return {
    inputTokens: known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null,
    outputTokens: count(usage.output_tokens),
    costUsd: count(envelope.total_cost_usd),
    model: models[0]?.name ?? null,
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
  };
}

// Claude Code's words for "not available now", and the reason the studio shows.
// The texts are the best known ones, not yet captured on the worker machine:
// the owner replaces the fixtures under decide/testdata/ (and these patterns
// if needed) with the real output during manual acceptance.
const UNAVAILABLE: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /usage limit|limit reached|hit your limit/i, reason: "the usage limit is reached" },
  {
    pattern:
      /please run \/login|not logged in|invalid api key|oauth token has expired|authentication_error/i,
    reason: "Claude Code is signed out",
  },
];

// The reason Claude Code is not available, from its result or output; null
// when the text says nothing of the kind.
export function aiUnavailableReason(text: string): string | null {
  return UNAVAILABLE.find(({ pattern }) => pattern.test(text))?.reason ?? null;
}

// Claude Code's `--output-format json` result: `structured_output` holds the
// answer `--json-schema` asked for, `result` the text answer (JSON as a
// fallback). Anything else is a broken answer, with whatever usage could be
// read.
export function parseClaudeResult(stdout: string): AiResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "broken", reason: `stdout is not JSON (${reason})`, usage: NO_USAGE };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { kind: "broken", reason: "stdout is not a result object", usage: NO_USAGE };
  }
  const result = envelope as Record<string, unknown>;
  const usage = usageOf(result);
  if (result.is_error === true) {
    const detail = typeof result.result === "string" ? result.result : String(result.subtype);
    const unavailable = aiUnavailableReason(detail);
    if (unavailable) return { kind: "unavailable", reason: unavailable, usage };
    return { kind: "broken", reason: `claude reported an error: ${detail}`, usage };
  }
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return { kind: "answer", answer: result.structured_output, usage };
  }
  if (typeof result.result === "string") {
    try {
      return { kind: "answer", answer: JSON.parse(result.result), usage };
    } catch {
      return { kind: "broken", reason: "the result text is not JSON", usage };
    }
  }
  return { kind: "broken", reason: "no structured_output and no result", usage };
}

// The `chat` span of one model call, a child of `request.trace`'s span, with
// the OpenTelemetry GenAI semantic conventions (status Development:
// https://github.com/open-telemetry/semantic-conventions-genai). Its name is
// `chat <request model>`, or `chat` when the call names no model. Spans are
// observation only: the call runs, and fails, as it would without one. A call
// that does not succeed carries `error.type` (`unavailable` or `broken`; a
// thrown call is `broken`) and an error status, as the OpenTelemetry rule for
// a failed operation asks: the job span may still end as a wait.
async function inChatSpan(request: AiRequest, work: () => Promise<AiResult>): Promise<AiResult> {
  if (!request.trace) return work();
  const { telemetry, parent } = request.trace;
  const model = request.model;
  const span = telemetry.tracer.startSpan(
    model ? `chat ${model}` : "chat",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        ...(model ? { "gen_ai.request.model": model } : {}),
      },
    },
    parent,
  );
  try {
    const result = await work();
    span.setAttributes(chatAttributes(result.usage));
    if (result.kind !== "answer") {
      span.setAttribute("error.type", result.kind);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setAttribute("error.type", "broken");
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

// The facts of one call on its `chat` span: the response model, the input
// tokens (every input token, as the GenAI Anthropic rule sums them), the
// output tokens, the cache counts when non-zero, and the cost (a custom
// attribute: the standard has none). A value Claude Code did not report is
// left out.
function chatAttributes(usage: AiUsage): Attributes {
  const attributes: Attributes = {};
  if (usage.model !== null) attributes["gen_ai.response.model"] = usage.model;
  if (usage.inputTokens !== null) attributes["gen_ai.usage.input_tokens"] = usage.inputTokens;
  if (usage.outputTokens !== null) attributes["gen_ai.usage.output_tokens"] = usage.outputTokens;
  if (usage.cacheReadTokens !== null && usage.cacheReadTokens > 0) {
    attributes["gen_ai.usage.cache_read.input_tokens"] = usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== null && usage.cacheWriteTokens > 0) {
    attributes["gen_ai.usage.cache_write.input_tokens"] = usage.cacheWriteTokens;
  }
  if (usage.costUsd !== null) attributes["edit_issebya.ai.cost_usd"] = usage.costUsd;
  return attributes;
}

// Claude Code without tools (or only Read on the request's one file) and
// without a saved session, the prompt on stdin, nothing shell-interpreted. A
// non-zero exit throws from the tool, unless its output (the thrown message
// carries its tail) says Claude Code is not available: that is an
// `unavailable` result.
function claudeRunner(path: string): AiRunner {
  return {
    call(tool, request) {
      return inChatSpan(request, async () => {
        const { prompt, schema, cwd, readFile, model } = request;
        const tools = toolArgs(readFile);
        const models = modelArgs(model);
        let stdout: string;
        try {
          stdout = await tool({
            file: path,
            args: [
              "-p",
              "--output-format",
              "json",
              "--json-schema",
              JSON.stringify(schema),
              ...tools,
              ...models,
              "--no-session-persistence",
            ],
            stdin: prompt,
            cwd,
            maxStdoutBytes: MAX_STDOUT_BYTES,
          });
        } catch (error) {
          const reason = aiUnavailableReason(
            error instanceof Error ? error.message : String(error),
          );
          if (reason) return { kind: "unavailable", reason, usage: NO_USAGE };
          throw error;
        }
        return parseClaudeResult(stdout);
      });
    },
  };
}

export interface FakeAiRunner extends AiRunner {
  // Every request, in order.
  calls: AiRequest[];
}

// The AI double: each call parses the next scripted Claude Code result (a
// string is raw stdout, an object is serialised), then the last again. It
// never spawns.
export function fakeAiRunner(script: unknown[]): FakeAiRunner {
  const calls: AiRequest[] = [];
  return {
    calls,
    call(_tool, request) {
      return inChatSpan(request, async () => {
        if (script.length === 0) throw new Error("fake AI runner has no scripted answer");
        // The same refusal as the real runner, so a bad file name fails in tests too.
        toolArgs(request.readFile);
        modelArgs(request.model);
        const entry = script[Math.min(calls.length, script.length - 1)];
        calls.push(request);
        return parseClaudeResult(typeof entry === "string" ? entry : JSON.stringify(entry));
      });
    },
  };
}

// A Claude Code result envelope around an answer, for the double.
export function resultEnvelope(answer: unknown): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: answer,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function scriptFrom(path: string): unknown[] {
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own script file
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`E2E_MOCK_AI_SCRIPT ${path} cannot be read: ${(error as Error).message}`);
  }
  let script: unknown;
  try {
    script = JSON.parse(text);
  } catch (error) {
    throw new Error(`E2E_MOCK_AI_SCRIPT ${path} is not JSON: ${(error as Error).message}`);
  }
  const refusal = `E2E_MOCK_AI_SCRIPT ${path} must be a non-empty JSON array or one result envelope`;
  if (Array.isArray(script)) {
    if (script.length === 0) throw new Error(refusal);
    return script;
  }
  if (script !== null && typeof script === "object") return [script];
  throw new Error(refusal);
}

// A decide answer with no items and no hook: what the double gives without a
// script.
export const EMPTY_DECIDE_ANSWER = {
  accents: [],
  big_words: [],
  photos: [],
  transitions: [],
  word_fixes: [],
  hook: null,
  checklist: [],
  behind_rules: { photos: "keep", big_word: "keep" },
  unexpressed: [],
};

// The double only when E2E_MOCK_AI is exactly "true" (its script from
// E2E_MOCK_AI_SCRIPT, a JSON array of answers replayed in order with the last
// repeating, or one envelope object used for every call; else the empty
// decide answer the doctor accepts); otherwise Claude Code.
export function aiRunner(env: Env = process.env): AiRunner {
  if (env.E2E_MOCK_AI === "true") {
    const path = env.E2E_MOCK_AI_SCRIPT?.trim();
    return fakeAiRunner(path ? scriptFrom(path) : [resultEnvelope(EMPTY_DECIDE_ANSWER)]);
  }
  return claudeRunner(env.CLAUDE_CODE_PATH?.trim() || "claude");
}

// A tool outside any step (the doctor): one child process, stdin written,
// stdout returned, a non-zero exit thrown with the end of stderr.
export const plainTool: Tool = (call) =>
  new Promise((resolve, reject) => {
    const child = spawn(call.file, call.args, {
      cwd: call.cwd,
      env: call.env ?? process.env,
      stdio: [call.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    if (call.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(call.stdin);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${call.file} exited with ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
