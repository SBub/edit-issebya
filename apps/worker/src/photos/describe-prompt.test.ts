import { describe, expect, it } from "vitest";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PROMPT_NAMES } from "../prompts/source.ts";
import { describePrompt } from "./describe-prompt.ts";

const TEMPLATE = await fakePromptSource().get(PROMPT_NAMES.describe);

describe("describePrompt", () => {
  it("sends the fetched prompt as the system message, unchanged, and names its version", () => {
    const call = describePrompt(TEMPLATE);
    expect(call.system).toBe(TEMPLATE.text);
    expect(call.promptVersion).toBe("photo-describe@v1");
  });

  it("has no input of its own: the user message is empty, the image is the whole message", () => {
    expect(describePrompt(TEMPLATE).prompt).toBe("");
  });

  it("puts the refused answer's reasons in the user message on the retry, and only then", () => {
    const retry = describePrompt(TEMPLATE, ["tags: Too small: expected array to have >=3 items"]);
    expect(retry.system).toBe(TEMPLATE.text);
    expect(retry.prompt).toBe(
      [
        "## previous_answer_refused",
        "",
        "Your previous answer was refused for these reasons. Fix them and answer again:",
        "- tags: Too small: expected array to have >=3 items",
        "",
      ].join("\n"),
    );
    expect(describePrompt(TEMPLATE, []).prompt).toBe(describePrompt(TEMPLATE).prompt);
  });
});
