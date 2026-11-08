import { type EditDiff, type EngineNote, ISSEBYA_PRESET } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import {
  AI_MODELS,
  EMPTY_DECIDE_ANSWER,
  type ScriptedReply,
  fakeAiRunner,
  scriptedAnswer,
} from "../ai.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PROMPT_NAMES, type PromptText } from "../prompts/source.ts";
import { summaryPrompt, writeVersionSummary } from "./version-summary.ts";

const PROMPT: PromptText = await fakePromptSource().get(PROMPT_NAMES.summary);

const DIFF: EditDiff = {
  items: [{ kind: "title", action: "added", id: "title", text: "Rethink work" }],
  rules: [],
};
const RECORD: EngineNote[] = [
  { item: "photo-1", action: "dropped", rule: "no-room", reason: "photo 1: no free place" },
];
function run(script: ScriptedReply[], diff: EditDiff = DIFF) {
  const ai = fakeAiRunner(script);
  const lines: string[] = [];
  const result = writeVersionSummary({
    ai,
    diff,
    record: RECORD,
    preset: ISSEBYA_PRESET,
    reelId: "r1",
    prompt: PROMPT,
    log: (line) => lines.push(line),
  });
  return { ai, lines, result };
}

describe("summaryPrompt", () => {
  it("fills the difference and the record as fenced JSON data, and names its prompt", () => {
    const call = summaryPrompt(PROMPT, { diff: DIFF, record: RECORD });
    expect(call.promptVersion).toBe("reel-version-summary@v1");
    expect(call.prompt).toContain(JSON.stringify(DIFF.items, null, 2));
    expect(call.prompt).toContain(
      JSON.stringify(
        [{ item: "photo-1", action: "dropped", reason: "photo 1: no free place" }],
        null,
        2,
      ),
    );
    expect(call.prompt).not.toContain('"rule": "no-room"');
    expect(call.prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it("names only the library photos the difference has, by description", () => {
    const photo = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";
    const { prompt } = summaryPrompt(PROMPT, {
      diff: {
        items: [{ kind: "photo", action: "added", id: "photo-1", photo_id: photo, reason: "mood" }],
        rules: [],
      },
      record: [],
      library: [
        { id: photo, description: "three wooden chairs" },
        { id: "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c", description: "gold earrings" },
      ],
    });
    expect(prompt).toContain(
      JSON.stringify([{ id: photo, description: "three wooden chairs" }], null, 2),
    );
    expect(prompt).not.toContain("gold earrings");
    // Without a library, no photo is named.
    expect(summaryPrompt(PROMPT, { diff: DIFF, record: [] }).prompt).toContain(
      ["```json", "[]", "```"].join("\n"),
    );
  });

  it("leaves out a text kept in place at low contrast: no change the viewer sees", () => {
    const { prompt } = summaryPrompt(PROMPT, {
      diff: DIFF,
      record: [
        ...RECORD,
        {
          item: "cw0",
          action: "low-contrast",
          rule: "contrast-stay",
          reason: 'captions "rethink work" stay in place: contrast 1.8:1',
        },
        {
          item: "accent-1",
          action: "shadowed",
          rule: "contrast-shadow",
          reason: 'accent "work" gets a soft shadow (level 2)',
        },
      ],
    });
    expect(prompt).toContain('"action": "dropped"');
    expect(prompt).not.toContain("low-contrast");
    expect(prompt).not.toContain("shadowed");
    expect(prompt).not.toContain("stay in place");
  });
});

describe("writeVersionSummary", () => {
  it("asks the summary role's model once and uses a passing answer, keeping the exchange", async () => {
    const { ai, result } = run([
      scriptedAnswer({ change_title: " Title added ", change_summary: "A title opens the reel." }),
    ]);
    expect(await result).toMatchObject({
      title: "Title added",
      summary: "A title opens the reel.",
      source: "ai",
    });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.role).toBe("summary");
    expect(AI_MODELS.summary).toBe("anthropic/claude-haiku-5.5");
    expect((await result).exchange).toMatchObject({ role: "summary", outputMode: "json_schema" });
  });

  it("gives the template for a summary naming a photo the difference does not have", async () => {
    const { lines, result } = run([
      scriptedAnswer({
        change_title: "Photo added behind you",
        change_summary: "A photo now shows behind you.",
      }),
    ]);
    const summary = await result;
    expect(summary.source).toBe("template");
    expect(summary.title).toBe("Title added");
    expect(summary.summary).not.toMatch(/asked/);
    expect(lines).toEqual([
      "decide: summary from the template, reel r1: safeguard: names a photo that is not in the saved difference (reel-version-summary@v1)",
    ]);
  });

  it("gives the template for a broken, an unavailable or a decide answer, never retrying", async () => {
    const limit: ScriptedReply = { error: { status: 429 } };
    for (const entry of ["not json", limit, scriptedAnswer(EMPTY_DECIDE_ANSWER)]) {
      const { ai, result } = run([entry]);
      expect((await result).source).toBe("template");
      expect(ai.calls).toHaveLength(1);
    }
  });

  it("makes no call for an empty difference", async () => {
    const { ai, result } = run([scriptedAnswer({})], { items: [], rules: [] });
    expect(await result).toMatchObject({ title: "No changes", source: "template" });
    expect(ai.calls).toHaveLength(0);
  });
});
