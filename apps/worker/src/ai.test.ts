import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiAnswerError, aiRunner, fakeAiRunner, parseClaudeJson } from "./ai.ts";

const call = { prompt: "x", schema: {} };
const NO_USAGE = { inputTokens: null, outputTokens: null, costUsd: null, model: null };

describe("aiRunner", () => {
  it("is the double only for exactly 'true'", async () => {
    expect(await aiRunner({ E2E_MOCK_AI: "true" }).runJson(call)).toEqual({
      output: { ok: true },
      usage: NO_USAGE,
    });
  });

  it("is Claude Code otherwise", async () => {
    for (const flag of [undefined, "1", "TRUE", " true"]) {
      const runner = aiRunner({ E2E_MOCK_AI: flag, CLAUDE_CODE_PATH: "/nonexistent/claude" });
      await expect(runner.runJson(call)).rejects.toThrow();
    }
  });

  it("reads the script E2E_MOCK_AI_SCRIPT names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-script-"));
    try {
      const file = join(dir, "script.json");
      const usage = { inputTokens: 1, outputTokens: 2, costUsd: 0.5, model: "claude-fake" };
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's own temporary folder
      await writeFile(file, JSON.stringify([{ output: { n: 1 }, usage }, { output: { n: 2 } }]));
      const runner = aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: file });
      expect(await runner.runJson(call)).toEqual({ output: { n: 1 }, usage });
      expect((await runner.runJson(call)).output).toEqual({ n: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a relative script path from the repository root", async () => {
    const runner = aiRunner({
      E2E_MOCK_AI: "true",
      E2E_MOCK_AI_SCRIPT: "fixtures/decide/short-speech.json",
    });
    const { usage } = await runner.runJson(call);
    expect(usage.model).toBe("claude-fake");
  });
});

describe("fakeAiRunner", () => {
  it("returns the script in order, then the last answer, and keeps the prompts", async () => {
    const runner = fakeAiRunner([{ output: 1 }, { output: 2 }]);
    const outputs = [];
    for (const prompt of ["a", "b", "c"])
      outputs.push((await runner.runJson({ ...call, prompt })).output);
    expect(outputs).toEqual([1, 2, 2]);
    expect(runner.prompts).toEqual(["a", "b", "c"]);
  });

  it("sends a raw stdout through the real parser", async () => {
    const runner = fakeAiRunner([{ stdout: "not json" }]);
    await expect(runner.runJson(call)).rejects.toThrow(AiAnswerError);
  });
});

describe("parseClaudeJson", () => {
  it("prefers structured_output", () => {
    expect(
      parseClaudeJson(
        JSON.stringify({ is_error: false, result: "", structured_output: { ok: true } }),
      ).output,
    ).toEqual({ ok: true });
  });

  it("falls back to parsing result", () => {
    expect(
      parseClaudeJson(JSON.stringify({ is_error: false, result: '{"ok":true}' })).output,
    ).toEqual({ ok: true });
  });

  it("throws on an error envelope, not as an unusable answer", () => {
    const parse = () => parseClaudeJson(JSON.stringify({ is_error: true, result: "quota" }));
    expect(parse).toThrow(/quota/);
    expect(parse).not.toThrow(AiAnswerError);
  });

  it("calls broken JSON an unusable answer", () => {
    expect(() => parseClaudeJson("not json")).toThrow(AiAnswerError);
    expect(() => parseClaudeJson(JSON.stringify({ result: "no {" }))).toThrow(AiAnswerError);
    expect(() => parseClaudeJson(JSON.stringify({ is_error: false }))).toThrow(AiAnswerError);
  });

  it("gives null for usage it does not report, never 0", () => {
    expect(parseClaudeJson(JSON.stringify({ structured_output: {} })).usage).toEqual(NO_USAGE);
  });

  it("reads output, tokens, cost and model from a real Claude Code result", async () => {
    // Captured once from `claude -p --output-format json --json-schema ...`, scrubbed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed Claude Code result
    const stdout = await readFile(
      new URL("./decide/testdata/claude-result.json", import.meta.url),
      "utf8",
    );
    const { output, usage } = parseClaudeJson(stdout);
    expect(output).toEqual({ ok: true });
    expect(usage).toEqual({
      inputTokens: 2 + 134913 + 0,
      outputTokens: 52,
      costUsd: 1.080352,
      model: "claude-opus-5-5",
    });
  });
});
