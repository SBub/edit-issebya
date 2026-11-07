import { describe, expect, it } from "vitest";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PROMPT_NAMES } from "../prompts/source.ts";
import { describePrompt } from "./describe-prompt.ts";

const TEMPLATE = await fakePromptSource().get(PROMPT_NAMES.describe);

describe("describePrompt", () => {
  it("sends the fetched prompt as it is, names its version and carries its temperature", () => {
    const call = describePrompt(TEMPLATE);
    expect(call.prompt).toBe(TEMPLATE.text);
    expect(call.promptVersion).toBe("photo-describe@v1");
    expect(call.temperature).toBe(TEMPLATE.temperature);
  });

  it("appends the refused answer's reasons on the retry, and only then", () => {
    const retry = describePrompt(TEMPLATE, ["tags: Too small: expected array to have >=3 items"]);
    expect(retry.prompt.startsWith(TEMPLATE.text)).toBe(true);
    expect(retry.prompt).toContain(
      "Your previous answer was refused for these reasons. Fix them and answer again:\n- tags: Too small",
    );
    expect(describePrompt(TEMPLATE, []).prompt).toBe(describePrompt(TEMPLATE).prompt);
  });
});
