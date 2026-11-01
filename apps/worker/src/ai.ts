import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Tool } from "./step-runner.ts";
import type { AiUsage } from "./step-store.ts";

type Env = Record<string, string | undefined>;

// One structured call: the prompt (on stdin), the JSON Schema the answer must
// match, and the folder Claude Code runs in.
export interface AiRequest {
  prompt: string;
  schema: object;
  cwd: string;
}

export type AiResult =
  | { kind: "answer"; answer: unknown; usage: AiUsage }
  | { kind: "broken"; reason: string; usage: AiUsage };

export interface AiRunner {
  // Runs through `tool`, so a step measures the call like any other tool.
  call(tool: Tool, request: AiRequest): Promise<AiResult>;
}

const NO_USAGE: AiUsage = { inputTokens: null, outputTokens: null, costUsd: null, model: null };
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Every input token Claude Code reports (fresh, cache writes, cache reads),
// the output tokens, the cost as reported, and the model that wrote the most
// output. Raw numbers, never converted; null where a field is missing.
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
  };
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

// Claude Code without tools or a saved session, the prompt on stdin, nothing
// shell-interpreted. A non-zero exit throws from the tool.
function claudeRunner(path: string): AiRunner {
  return {
    async call(tool, { prompt, schema, cwd }) {
      const stdout = await tool({
        file: path,
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(schema),
          "--tools",
          "",
          "--no-session-persistence",
        ],
        stdin: prompt,
        cwd,
        maxStdoutBytes: MAX_STDOUT_BYTES,
      });
      return parseClaudeResult(stdout);
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
    async call(_tool, request) {
      if (script.length === 0) throw new Error("fake AI runner has no scripted answer");
      const entry = script[Math.min(calls.length, script.length - 1)];
      calls.push(request);
      return parseClaudeResult(typeof entry === "string" ? entry : JSON.stringify(entry));
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
  if (!Array.isArray(script) || script.length === 0) {
    throw new Error(`E2E_MOCK_AI_SCRIPT ${path} must be a non-empty JSON array`);
  }
  return script;
}

// The double only when E2E_MOCK_AI is exactly "true" (its script from
// E2E_MOCK_AI_SCRIPT, else the doctor's `{ ok: true }`); otherwise Claude Code.
export function aiRunner(env: Env = process.env): AiRunner {
  if (env.E2E_MOCK_AI === "true") {
    const path = env.E2E_MOCK_AI_SCRIPT?.trim();
    return fakeAiRunner(path ? scriptFrom(path) : [resultEnvelope({ ok: true })]);
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
