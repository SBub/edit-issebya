import { describe, expect, it } from "vitest";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { isTransient } from "../failure.ts";
import {
  PROMPT_NAMES,
  type PromptText,
  PromptUnavailable,
  decidePrompts,
  promptIdentity,
  promptLabel,
  renderPrompt,
} from "./source.ts";

const TEMPLATE: PromptText = {
  name: "reel-hook",
  version: 3,
  label: "production",
  text: "test prompt {{transcript}} and {{unknown}}",
};

describe("renderPrompt", () => {
  it("fills the variables it is given, leaves the others, and names the version", () => {
    expect(renderPrompt(TEMPLATE, { transcript: "hello" })).toEqual({
      prompt: "test prompt hello and {{unknown}}",
      promptVersion: "reel-hook@v3",
    });
  });

  it("appends every refused reason on a retry, and nothing when there are none", () => {
    const retry = renderPrompt(TEMPLATE, { transcript: "x" }, ["a: first", "b: second"]);
    expect(retry.prompt.split("\n").slice(-4)).toEqual([
      "Your previous answer was refused for these reasons. Fix them and answer again:",
      "- a: first",
      "- b: second",
      "",
    ]);
    expect(renderPrompt(TEMPLATE, { transcript: "x" }, []).prompt).toBe(
      renderPrompt(TEMPLATE, { transcript: "x" }).prompt,
    );
  });
});

describe("renderPrompt on a stale copy", () => {
  it("marks the call as stale, and leaves the flag off a fresh prompt", () => {
    expect(renderPrompt({ ...TEMPLATE, stale: true }, { transcript: "x" })).toEqual({
      prompt: "test prompt x and {{unknown}}",
      promptVersion: "reel-hook@v3",
      promptStale: true,
    });
    expect(renderPrompt(TEMPLATE, { transcript: "x" })).not.toHaveProperty("promptStale");
  });
});

describe("promptIdentity and promptLabel", () => {
  it("records the name and the version", () => {
    expect(promptIdentity({ name: "reel-components", version: 1 })).toBe("reel-components@v1");
  });

  it("fetches by POSTHOG_PROMPT_LABEL, or production when it is unset or blank", () => {
    expect(promptLabel({})).toBe("production");
    expect(promptLabel({ POSTHOG_PROMPT_LABEL: "  " })).toBe("production");
    expect(promptLabel({ POSTHOG_PROMPT_LABEL: "staging" })).toBe("staging");
  });
});

describe("the prompt errors", () => {
  it("are transient, so the step may be tried again", () => {
    const error = new PromptUnavailable("reel-hook", "production", "PostHog did not answer");
    expect(error.message).toBe(
      "prompts: reel-hook (label production) could not be fetched: PostHog did not answer",
    );
    expect(isTransient(error)).toBe(true);
  });
});

describe("decidePrompts", () => {
  it("fetches the two decide prompts by their names", async () => {
    const asked: string[] = [];
    const source = {
      async get(name: string) {
        asked.push(name);
        return fakePromptSource().get(name);
      },
    };
    const prompts = await decidePrompts(source);
    expect(asked.sort()).toEqual([PROMPT_NAMES.hook, PROMPT_NAMES.components].sort());
    expect(prompts.components.name).toBe("reel-components");
  });
});
