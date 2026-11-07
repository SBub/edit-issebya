import { readFileSync } from "node:fs";
import {
  ISSEBYA_PRESET,
  hookAnswerSchemaFor,
  hookJsonSchema,
  parseHookAnswer,
  transcriptSchema,
} from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PROMPT_NAMES, type PromptText } from "../prompts/source.ts";
import { hookGlossaryReasons, hookInput, hookPrompt } from "./hook.ts";

const TEMPLATE: PromptText = await fakePromptSource().get(PROMPT_NAMES.hook);

const read = (path: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const transcript = transcriptSchema.parse(
  read("../../../../fixtures/pipeline/retime/transcript.json"),
);

describe("the hook call's input", () => {
  it("gives the transcript's words in order, with no ids, times or geometry", () => {
    const input = hookInput(transcript, ISSEBYA_PRESET);
    expect(input.transcript).toBe("This is a short test clip for the real studio.");
    expect(JSON.stringify(input)).not.toMatch(/"w\d{4}"|"start"|"end"|"position"|"face"/);
  });

  it("gives the style's hook length and the glossary, as the components see them", () => {
    const input = hookInput(transcript, ISSEBYA_PRESET);
    expect(input.style.hook_length).toEqual({ words: 7, characters: 45 });
    expect(input.style.glossary).toEqual(ISSEBYA_PRESET.glossary);
  });
});

describe("the hook prompt", () => {
  const call = hookPrompt(TEMPLATE, hookInput(transcript, ISSEBYA_PRESET));

  it("names its prompt and carries the prompt's temperature", () => {
    expect(call.promptVersion).toBe("reel-hook@v1");
    expect(call.temperature).toBe(TEMPLATE.temperature);
  });

  it("fills the transcript and the style as data, with no placeholder left", () => {
    expect(call.prompt).toContain('"This is a short test clip for the real studio."');
    expect(call.prompt).toContain('"hook_length": {\n    "words": 7,\n    "characters": 45\n  }');
    expect(call.prompt).toContain('"term": "lock-in"');
    expect(call.prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it("appends every reason on the retry, and only then", () => {
    const reasons = ["text: a hook has at most 7 words"];
    const retry = hookPrompt(TEMPLATE, hookInput(transcript, ISSEBYA_PRESET), reasons);
    expect(retry.prompt.trimEnd().split("\n").slice(-2)).toEqual([
      "Your previous answer was refused for these reasons. Fix them and answer again:",
      "- text: a hook has at most 7 words",
    ]);
    expect(call.prompt).not.toContain("Your previous answer was refused");
  });
});

describe("the hook call's schema", () => {
  it("is one closed object: a required text, never null, nothing else", () => {
    const schema = hookJsonSchema(ISSEBYA_PRESET) as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(["text"]);
    expect(schema.required).toEqual(["text"]);
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('"null"');
    expect(hookAnswerSchemaFor(ISSEBYA_PRESET).safeParse({ text: "Would you?" }).success).toBe(
      true,
    );
  });

  it("reads the hook's text and stops at the reason it is refused for", () => {
    expect(parseHookAnswer({ text: "Gen Z won't work like you did." }, ISSEBYA_PRESET)).toEqual({
      ok: true,
      text: "Gen Z won't work like you did",
    });
    const refused = parseHookAnswer(
      { text: "one two three four five six seven eight" },
      ISSEBYA_PRESET,
    );
    expect(refused).toEqual({ ok: false, reasons: ["text: a hook has at most 7 words"] });
  });
});

describe("the hook's glossary check", () => {
  it("refuses a heard form of a glossary term, and passes the term", () => {
    expect(hookGlossaryReasons("Stop locking yourself", ISSEBYA_PRESET)).toEqual([
      'glossary hook: the hook shows "Stop locking yourself": write the glossary term "lock-in"',
    ]);
    expect(hookGlossaryReasons("No more lock-in", ISSEBYA_PRESET)).toEqual([]);
  });
});
