import { execFile } from "node:child_process";
import { promisify } from "node:util";

type Env = Record<string, string | undefined>;

export interface AiRunner {
  // One structured call: the answer matches the JSON schema.
  runJson(prompt: string, schema: object): Promise<unknown>;
}

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;

// Claude Code's `--output-format json` envelope: `structured_output` holds the
// answer `--json-schema` asked for; `result` is the plain text answer.
export function parseClaudeJson(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as {
    is_error?: boolean;
    result?: unknown;
    structured_output?: unknown;
  };
  if (envelope.is_error) {
    throw new Error(`claude reported an error: ${String(envelope.result ?? "unknown")}`);
  }
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  if (typeof envelope.result === "string") return JSON.parse(envelope.result);
  throw new Error("claude answered without structured_output or result");
}

// Runs `claude -p` directly (no shell), so the prompt is never interpreted.
function claudeRunner(path: string): AiRunner {
  return {
    async runJson(prompt, schema) {
      const { stdout } = await run(
        path,
        ["-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema)],
        { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );
      return parseClaudeJson(stdout);
    },
  };
}

// The AI double: returns the scripted answers in order, then the last again.
export function fakeAiRunner(script: unknown[]): AiRunner {
  let index = 0;
  return {
    async runJson() {
      if (script.length === 0) throw new Error("fake AI runner has no scripted answer");
      const answer = script[Math.min(index, script.length - 1)];
      index += 1;
      return answer;
    },
  };
}

// The double only when E2E_MOCK_AI is exactly "true"; otherwise Claude Code.
export function aiRunner(env: Env = process.env): AiRunner {
  if (env.E2E_MOCK_AI === "true") return fakeAiRunner([{ ok: true }]);
  return claudeRunner(env.CLAUDE_CODE_PATH?.trim() || "claude");
}
