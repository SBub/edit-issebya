import { readFileSync } from "node:fs";
import { ISSEBYA_PRESET, type Transcript, transcriptSchema } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { decideInput } from "./input.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PROMPT_NAMES, type PromptText } from "../prompts/source.ts";
import { decidePrompt } from "./prompt.ts";

const TEMPLATE: PromptText = await fakePromptSource().get(PROMPT_NAMES.components);

// The written hook the reel opens with, as the hook call wrote it.
const HOOK = { text: "Gen Z won't work like you did" };

const read = (path: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const transcript: Transcript = transcriptSchema.parse(
  read("../../../../fixtures/pipeline/retime/transcript.json"),
);
const input = decideInput({ transcript, preset: ISSEBYA_PRESET, hook: HOOK });

describe("decidePrompt", () => {
  it("names its prompt", () => {
    expect(decidePrompt(TEMPLATE, input).promptVersion).toBe("reel-components@v1");
  });

  it("fills every variable of the template, and no other", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(TEMPLATE.text.match(/\{\{(\w+)\}\}/g)).toEqual([
      "{{script}}",
      "{{hook}}",
      "{{intensity}}",
      "{{target_picks}}",
    ]);
  });

  it("fills the script with every sentence and every word id, in order", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt).toContain(JSON.stringify(input.script, null, 2));
    for (const word of transcript.words) expect(prompt).toContain(`"id": "${word.id}"`);
  });

  it("fills the hook as data: the hook call's text", () => {
    expect(decidePrompt(TEMPLATE, input).prompt).toContain(JSON.stringify(HOOK, null, 2));
  });

  it("sends no glossary: the components prompt never names one", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt).not.toContain("glossary");
    expect(prompt).not.toContain('"term"');
  });

  it("fills the intensity as a lowercase word and the target as a number, last", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    expect(prompt.trimEnd().endsWith(`\`\`\` intense ${input.target_picks}`)).toBe(true);
    const calm = decideInput({
      transcript,
      preset: { ...ISSEBYA_PRESET, intensity: "calm" },
      hook: HOOK,
    });
    expect(
      decidePrompt(TEMPLATE, calm).prompt.trimEnd().endsWith(`\`\`\` calm ${calm.target_picks}`),
    ).toBe(true);
  });

  it("sends none of the removed inputs: no choices, no transcript, no preset", () => {
    const { prompt } = decidePrompt(TEMPLATE, input);
    for (const removed of [
      "current_choices",
      "behind_rules",
      '"transitions"',
      '"accents"',
      '"preset"',
      "glossary",
      "sentences",
    ]) {
      expect(prompt).not.toContain(removed);
    }
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

describe("decidePrompt on a prompt with no placeholder", () => {
  const SYSTEM: PromptText = { ...TEMPLATE, text: "test system prompt reel-components" };
  const fence = (value: unknown) => ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

  it("sends the prompt unchanged as the system message, and the four inputs as the user message", () => {
    const call = decidePrompt(SYSTEM, input);
    expect(call.system).toBe(SYSTEM.text);
    expect(call.prompt).toBe(
      [
        "## script",
        "",
        fence(input.script),
        "",
        "## hook",
        "",
        fence(HOOK),
        "",
        "## intensity",
        "",
        "intense",
        "",
        "## target_picks",
        "",
        String(input.target_picks),
        "",
      ].join("\n"),
    );
    expect(call.promptVersion).toBe("reel-components@v1");
  });

  it("keeps the system message the same on the retry: the reasons are the user message's last section", () => {
    const reasons = ["accents.0.to: ends before it starts"];
    const first = decidePrompt(SYSTEM, input);
    const retry = decidePrompt(SYSTEM, input, reasons);
    expect(retry.system).toBe(first.system);
    expect(retry.prompt.startsWith(first.prompt)).toBe(true);
    expect(retry.prompt.slice(first.prompt.length)).toBe(
      [
        "",
        "## previous_answer_refused",
        "",
        "Your previous answer was refused for these reasons. Fix them and answer again:",
        "- accents.0.to: ends before it starts",
        "",
      ].join("\n"),
    );
  });
});
