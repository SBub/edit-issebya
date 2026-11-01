import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "./step-runner.ts";
import type { AiUsage } from "./step-store.ts";

type Env = Record<string, string | undefined>;

// One structured call. `tool` runs Claude Code inside a measured step (the
// decide step); without it (the doctor) a plain child process does.
export interface AiCall {
  prompt: string;
  // The answer matches it.
  schema: object;
  tool?: Tool;
  // The child's working folder.
  cwd?: string;
}

export interface AiResult {
  output: unknown;
  usage: AiUsage;
}

export interface AiRunner {
  runJson(call: AiCall): Promise<AiResult>;
}

// The answer is unusable (not JSON, no structured output): the decide step
// counts it as a failed attempt. Any other error (an error result, a non-zero
// exit, a timeout) fails the step at once.
export class AiAnswerError extends Error {
  // What the call cost, when the envelope itself was readable.
  readonly usage: AiUsage | undefined;

  constructor(message: string, usage?: AiUsage) {
    super(message);
    this.usage = usage;
  }
}

const DECIDE_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const REPO_ROOT = new URL("../../../", import.meta.url);

interface Envelope {
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

// Input tokens count the cached ones too: every token the model read.
function inputTokens(usage: Record<string, unknown>): number | null {
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].filter((value) => typeof value === "number");
  return parts.length === 0 ? null : parts.reduce((sum, value) => sum + value, 0);
}

// Claude Code's `--output-format json` result: `structured_output` holds the
// answer `--json-schema` asked for (`result` the same as text), `usage` the
// tokens, `total_cost_usd` the cost and `modelUsage` one key per model used.
// A missing number is null, never 0.
export function parseClaudeJson(stdout: string): AiResult {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(stdout) as Envelope;
  } catch {
    throw new AiAnswerError("claude's result is not JSON");
  }
  if (envelope === null || typeof envelope !== "object") {
    throw new AiAnswerError("claude's result is not a JSON object");
  }
  if (envelope.is_error) {
    throw new Error(`claude reported an error: ${String(envelope.result ?? "unknown")}`);
  }
  const counts = envelope.usage ?? {};
  const models = Object.keys(envelope.modelUsage ?? {});
  const usage: AiUsage = {
    inputTokens: inputTokens(counts),
    outputTokens: numberOrNull(counts.output_tokens),
    costUsd: numberOrNull(envelope.total_cost_usd),
    model: models.length > 0 ? models.join(",") : null,
  };
  if (envelope.structured_output !== undefined)
    return { output: envelope.structured_output, usage };
  if (typeof envelope.result !== "string") {
    throw new AiAnswerError("claude answered without structured_output or result", usage);
  }
  try {
    return { output: JSON.parse(envelope.result) as unknown, usage };
  } catch {
    throw new AiAnswerError("claude's answer is not JSON", usage);
  }
}

// A child process with no measuring, for a call outside any step (the doctor).
const plainTool: Tool = (call) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      call.file,
      call.args,
      { cwd: call.cwd, env: call.env, timeout: call.timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    if (call.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(call.input);
    }
  });

// `claude -p` run directly (no shell) with the prompt on stdin, never in argv,
// and no tools for the model.
function claudeRunner(path: string): AiRunner {
  return {
    async runJson({ prompt, schema, tool = plainTool, cwd }) {
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
        input: prompt,
        cwd,
        timeoutMs: DECIDE_TIMEOUT_MS,
      });
      return parseClaudeJson(stdout);
    },
  };
}

// One scripted answer: the output with its usage, or a raw stdout that goes
// through the real parser.
export type FakeAnswer = { output: unknown; usage?: Partial<AiUsage> } | { stdout: string };

// The AI double: the scripted answers in order, then the last again. Every
// call's prompt is kept in `prompts`.
export function fakeAiRunner(script: FakeAnswer[]): AiRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async runJson({ prompt }) {
      prompts.push(prompt);
      const entry = script[Math.min(prompts.length - 1, script.length - 1)];
      if (entry === undefined) throw new Error("fake AI runner has no scripted answer");
      if ("stdout" in entry) return parseClaudeJson(entry.stdout);
      return {
        output: entry.output,
        usage: {
          inputTokens: entry.usage?.inputTokens ?? null,
          outputTokens: entry.usage?.outputTokens ?? null,
          costUsd: entry.usage?.costUsd ?? null,
          model: entry.usage?.model ?? null,
        },
      };
    },
  };
}

// The double reading its script from a JSON file at the first call (a
// relative path is from the repository root).
function fileScriptedRunner(path: string): AiRunner {
  const file = isAbsolute(path) ? path : fileURLToPath(new URL(path, REPO_ROOT));
  let runner: Promise<AiRunner> | undefined;
  return {
    async runJson(call) {
      runner ??= (async () => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test script E2E_MOCK_AI_SCRIPT names
        const script = JSON.parse(await readFile(file, "utf8")) as unknown;
        if (!Array.isArray(script))
          throw new Error(`E2E_MOCK_AI_SCRIPT is not a JSON array: ${file}`);
        return fakeAiRunner(script as FakeAnswer[]);
      })();
      return (await runner).runJson(call);
    },
  };
}

// The double only when E2E_MOCK_AI is exactly "true" (scripted from the file
// E2E_MOCK_AI_SCRIPT names, else always `{ ok: true }` for the doctor);
// otherwise Claude Code.
export function aiRunner(env: Env = process.env): AiRunner {
  if (env.E2E_MOCK_AI === "true") {
    const script = env.E2E_MOCK_AI_SCRIPT?.trim();
    return script ? fileScriptedRunner(script) : fakeAiRunner([{ output: { ok: true } }]);
  }
  return claudeRunner(env.CLAUDE_CODE_PATH?.trim() || "claude");
}
