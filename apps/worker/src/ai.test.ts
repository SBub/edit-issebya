import { describe, expect, it } from "vitest";
import { aiRunner, fakeAiRunner, parseClaudeJson } from "./ai.ts";

describe("aiRunner", () => {
  it("is the double only for exactly 'true'", async () => {
    expect(await aiRunner({ E2E_MOCK_AI: "true" }).runJson("x", {})).toEqual({ ok: true });
  });

  it("is Claude Code otherwise", async () => {
    for (const flag of [undefined, "1", "TRUE", " true"]) {
      const runner = aiRunner({ E2E_MOCK_AI: flag, CLAUDE_CODE_PATH: "/nonexistent/claude" });
      await expect(runner.runJson("x", {})).rejects.toThrow();
    }
  });
});

describe("fakeAiRunner", () => {
  it("returns the script in order, then the last answer", async () => {
    const runner = fakeAiRunner([1, 2]);
    expect([
      await runner.runJson("", {}),
      await runner.runJson("", {}),
      await runner.runJson("", {}),
    ]).toEqual([1, 2, 2]);
  });
});

describe("parseClaudeJson", () => {
  it("prefers structured_output", () => {
    expect(
      parseClaudeJson(
        JSON.stringify({ is_error: false, result: "", structured_output: { ok: true } }),
      ),
    ).toEqual({ ok: true });
  });

  it("falls back to parsing result", () => {
    expect(parseClaudeJson(JSON.stringify({ is_error: false, result: '{"ok":true}' }))).toEqual({
      ok: true,
    });
  });

  it("throws on an error envelope", () => {
    expect(() => parseClaudeJson(JSON.stringify({ is_error: true, result: "quota" }))).toThrow(
      /quota/,
    );
  });
});
