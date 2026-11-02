import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aiRunner,
  aiUnavailableReason,
  fakeAiRunner,
  parseClaudeResult,
  resultEnvelope,
} from "./ai.ts";
import type { Tool } from "./step-runner.ts";

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
  it("is the double only for exactly 'true', answering ok without a script", async () => {
    expect(await aiRunner({ E2E_MOCK_AI: "true" }).call(NEVER, REQUEST)).toMatchObject({
      kind: "answer",
      answer: { ok: true },
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
      },
    });
  });

  it("falls back to parsing result", () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: '{"ok":true}' }))).toEqual({
      kind: "answer",
      answer: { ok: true },
      usage: { inputTokens: null, outputTokens: null, costUsd: null, model: null },
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
      usage: { inputTokens: null, outputTokens: null, costUsd: null, model: null },
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
