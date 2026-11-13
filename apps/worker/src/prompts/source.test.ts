import { describe, expect, it } from "vitest";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { isTransient } from "../failure.ts";
import {
  PROMPT_NAMES,
  type PromptText,
  PromptUnavailable,
  decidePrompts,
  hasPlaceholders,
  promptIdentity,
  promptLabel,
  renderPrompt,
  userMessage,
} from "./source.ts";

const TEMPLATE: PromptText = {
  name: "reel-hook",
  version: 3,
  label: "production",
  text: "test prompt {{transcript}} and {{unknown}}",
};

const REF = { name: "reel-hook", version: 3, label: "production" };
// A prompt with no placeholder: the system message of the two-message path.
const SYSTEM: PromptText = { ...TEMPLATE, text: "test system prompt reel-hook" };

describe("hasPlaceholders", () => {
  it("is true only for a text with a {{name}} placeholder", () => {
    expect(hasPlaceholders("a {{script}} b")).toBe(true);
    expect(hasPlaceholders("a {{target_picks}}")).toBe(true);
    expect(hasPlaceholders("no placeholder")).toBe(false);
    // JSON braces in an example answer are not placeholders.
    expect(hasPlaceholders('{"verdicts": [{"pick": "p1"}]}')).toBe(false);
    expect(hasPlaceholders("{ { script } }")).toBe(false);
    expect(hasPlaceholders("{{}}")).toBe(false);
  });
});

describe("renderPrompt on a prompt with no placeholder (system and user messages)", () => {
  it("sends the fetched text unchanged as the system message", () => {
    const text = "  test system prompt\n\nwith a blank line and a trailing newline\n";
    const call = renderPrompt({ ...SYSTEM, text }, { transcript: "hello" });
    expect(call.system).toBe(text);
    expect(call.promptVersion).toBe("reel-hook@v3");
    expect(call.promptRef).toEqual(REF);
  });

  it("puts each input in its own labelled section of the user message, in the order given", () => {
    const call = renderPrompt(SYSTEM, {
      script: '```json\n{"a":1}\n```',
      intensity: "intense",
      target_picks: "12",
    });
    expect(call.prompt).toBe(
      [
        "## script",
        "",
        "```json",
        '{"a":1}',
        "```",
        "",
        "## intensity",
        "",
        "intense",
        "",
        "## target_picks",
        "",
        "12",
        "",
      ].join("\n"),
    );
    // No input reaches the system message.
    expect(call.system).toBe(SYSTEM.text);
  });

  it("adds the refused reasons as the last section on a retry, and the system message stays the same", () => {
    const first = renderPrompt(SYSTEM, { transcript: "x" });
    const retry = renderPrompt(SYSTEM, { transcript: "x" }, ["a: first", "b: second"]);
    expect(retry.system).toBe(first.system);
    expect(retry.prompt).toBe(
      [
        "## transcript",
        "",
        "x",
        "",
        "## previous_answer_refused",
        "",
        "Your previous answer was refused for these reasons. Fix them and answer again:",
        "- a: first",
        "- b: second",
        "",
      ].join("\n"),
    );
    expect(renderPrompt(SYSTEM, { transcript: "x" }, []).prompt).toBe(first.prompt);
  });

  it("has an empty user message with no input and no reason", () => {
    expect(userMessage({})).toBe("");
    expect(renderPrompt(SYSTEM, {})).toMatchObject({ prompt: "", system: SYSTEM.text });
  });

  it("names a draft by its id", () => {
    const draft: PromptText = {
      name: "draft",
      version: 0,
      label: "draft",
      text: "test system prompt draft",
      draftId: "draft:ba7816bf8f01",
    };
    expect(renderPrompt(draft, {}).promptRef).toEqual({
      name: "draft",
      version: 0,
      label: "draft",
      draftId: "draft:ba7816bf8f01",
    });
  });
});

describe("renderPrompt on a template (placeholders: one message, as before)", () => {
  it("fills the variables it is given, leaves the others, names the version and sends no system message", () => {
    const call = renderPrompt(TEMPLATE, { transcript: "hello" });
    expect(call).toEqual({
      prompt: "test prompt hello and {{unknown}}",
      promptVersion: "reel-hook@v3",
      promptRef: REF,
    });
    expect(call).not.toHaveProperty("system");
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
      promptRef: REF,
      promptStale: true,
    });
    expect(renderPrompt({ ...SYSTEM, stale: true }, {})).toMatchObject({ promptStale: true });
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
