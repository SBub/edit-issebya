import { readFileSync } from "node:fs";
import { ISSEBYA_PRESET, choicesOf, parseEdit, transcriptSchema } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { currentChoices, decideInput } from "./input.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PROMPT_NAMES, type PromptText } from "../prompts/source.ts";
import { decidePrompt } from "./prompt.ts";

const TEMPLATE: PromptText = await fakePromptSource().get(PROMPT_NAMES.components);

// The written hook the reel opens with, as the hook call wrote it.
const HOOK = { text: "Gen Z won't work like you did" };

const read = (path: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const transcript = transcriptSchema.parse(
  read("../../../../fixtures/pipeline/retime/transcript.json"),
);
const parsed = parseEdit(
  read("../../../../packages/edit/src/testdata/versions/baseline-short-speech.edit.json"),
  ISSEBYA_PRESET,
  transcript,
);
if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
const current = parsed.edit;
const input = decideInput({
  current,
  transcript,
  preset: ISSEBYA_PRESET,
  hook: HOOK,
});

describe("decidePrompt", () => {
  it("names its prompt", () => {
    const call = decidePrompt(TEMPLATE, input);
    expect(call.promptVersion).toBe("reel-components@v1");
  });

  it("is given the hook as data: the hook call's text, never in the current choices", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt).toContain(JSON.stringify(HOOK, null, 2));
    expect(input.current_choices).not.toHaveProperty("hook");
    expect(input.hook).toEqual(HOOK);
  });

  it("carries the current choices in the answer's terms, every word id and the glossary", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt).toContain(
      JSON.stringify(currentChoices(choicesOf(current, transcript, ISSEBYA_PRESET)), null, 2),
    );
    for (const word of transcript.words) expect(prompt).toContain(`"id": "${word.id}"`);
    expect(prompt).toContain('"term": "lock-in"');
  });

  it("fills the edit intensity as the preset's level, a lowercase word", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt.trimEnd().endsWith("intense")).toBe(true);
    const calm = decideInput({
      current,
      transcript,
      preset: { ...ISSEBYA_PRESET, intensity: "calm" },
      hook: HOOK,
    });
    expect(decidePrompt(TEMPLATE, calm).prompt.trimEnd().endsWith("calm")).toBe(true);
  });

  it("has no input left unfilled, and no photo library in its inputs", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(input).not.toHaveProperty("library");
  });

  it("fills the switched-off rules and the preset as fenced data", () => {
    const { prompt } = decidePrompt(
      TEMPLATE,
      decideInput({
        current,
        transcript,
        preset: ISSEBYA_PRESET,
        forbid: { photos: true, bigWord: true },
        hook: HOOK,
      }),
    );
    expect(prompt).toContain(
      ['"photos_forbidden": true,', '  "big_word_forbidden": true', "}"].join("\n"),
    );
    expect(prompt).toContain('"transitions": [');
  });

  it("ends with every reason on the retry", () => {
    const reasons = ["accents.0.to: ends before it starts", "glossary cw0003: write lock-in"];
    const { prompt } = decidePrompt(TEMPLATE, input, reasons);
    expect(prompt.trimEnd().split("\n").slice(-3)).toEqual([
      "Your previous answer was refused for these reasons. Fix them and answer again:",
      ...reasons.map((reason) => `- ${reason}`),
    ]);
  });
});
