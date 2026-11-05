import { describe, expect, it } from "vitest";
import { aiRunner } from "../ai.ts";
import { maskToolArgs } from "../cutout/mask-tool.ts";
import { claudeArgsRefusal, cutoutArgsRefusal, insideFolder } from "./policy.ts";
import type { Tool as StepTool } from "../step-runner.ts";

const SCRATCH = "/Users/me/scratch";

describe("insideFolder", () => {
  it("accepts a normal path under the folder and refuses everything else", () => {
    expect(insideFolder(`${SCRATCH}/job/a.mp4`, SCRATCH)).toBe(true);
    expect(insideFolder(SCRATCH, SCRATCH)).toBe(false);
    expect(insideFolder(`${SCRATCH}/../etc`, SCRATCH)).toBe(false);
    expect(insideFolder("relative/a.mp4", SCRATCH)).toBe(false);
    expect(insideFolder("/Users/me/scratch-other/a.mp4", SCRATCH)).toBe(false);
  });
});

describe("claudeArgsRefusal", () => {
  it("accepts every argv the worker's Claude Code runner builds", async () => {
    // The argv ai.ts builds, captured through its own runner: the decide and
    // summary calls (no tools, a model) and the describe call (Read on one file).
    const seen: string[][] = [];
    const tool: StepTool = async (call) => {
      seen.push(call.args);
      return JSON.stringify({ type: "result", is_error: false, structured_output: {} });
    };
    const runner = aiRunner({ CLAUDE_CODE_PATH: "/opt/claude" });
    const schema = { type: "object" };
    await runner.call(tool, { prompt: "p", schema, cwd: SCRATCH });
    await runner.call(tool, { prompt: "p", schema, cwd: SCRATCH, model: "claude-haiku-5-5" });
    await runner.call(tool, { prompt: "p", schema, cwd: SCRATCH, readFile: "photo.jpg" });
    expect(seen).toHaveLength(3);
    for (const argv of seen) expect(claudeArgsRefusal(argv), argv.join(" ")).toBeNull();
  });

  it("refuses the first argument not being -p, unknown flags and widened tools", () => {
    expect(claudeArgsRefusal(["--output-format", "json"])).toMatch(/must be -p/);
    expect(claudeArgsRefusal(["-p", "--dangerously-skip-permissions"])).toMatch(/not allowed/);
    expect(claudeArgsRefusal(["-p", "--tools", "Bash"])).toMatch(/--tools/);
    expect(claudeArgsRefusal(["-p", "--add-dir", "/"])).toMatch(/--add-dir/);
    expect(claudeArgsRefusal(["-p", "--allowedTools", "Read(../x)"])).toMatch(/--allowedTools/);
    expect(claudeArgsRefusal(["-p", "--model"])).toMatch(/--model/);
    expect(claudeArgsRefusal(["-p", "--json-schema", "[1]"])).toMatch(/--json-schema/);
  });
});

describe("cutoutArgsRefusal", () => {
  const span = {
    input: `${SCRATCH}/cutout-x/footage.mp4`,
    start: 5.1,
    end: 7.9667,
    output: `${SCRATCH}/cutout-x/fp.mp4`,
  };

  it("accepts the arguments the mask tool gets, inside the scratch folder", () => {
    expect(cutoutArgsRefusal(maskToolArgs(span), SCRATCH)).toBeNull();
  });

  it("refuses a path outside the scratch folder, a different shape, or a non-number", () => {
    expect(cutoutArgsRefusal(maskToolArgs({ ...span, input: "/etc/passwd" }), SCRATCH)).toMatch(
      /inside the scratch folder/,
    );
    expect(cutoutArgsRefusal(["--input", span.input], SCRATCH)).toMatch(/expected/);
    expect(
      cutoutArgsRefusal(
        ["--input", span.input, "--start", "x", "--end", "1", "--output", span.output],
        SCRATCH,
      ),
    ).toMatch(/seconds/);
    expect(
      cutoutArgsRefusal(
        ["--input", span.input, "--start", "0", "--end", "1", "--other", span.output],
        SCRATCH,
      ),
    ).toMatch(/not the mask tool/);
  });
});
