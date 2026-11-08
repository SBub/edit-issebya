import { type PromptSource, PromptUnavailable, type PromptText } from "../src/prompts/source.ts";

// The placeholder prompts tests and the E2E double use. They hold no real
// wording (the owner's rule, AGENTS.md): each is one neutral line naming the
// prompt, with the `{{variables}}` its call fills. Versions are 1; the label is
// `production`, as the worker's default.
const TEMPLATES: Record<string, { text: string }> = {
  "reel-hook": { text: "test prompt reel-hook {{transcript}} {{style}}" },
  "reel-components": {
    text: "test prompt reel-components {{current_choices}} {{transcript}} {{sentences}} {{preset}} {{behind_rules}} {{hook}}",
  },
  "reel-version-summary": {
    text: "test prompt reel-version-summary {{difference}} {{rules_changed}} {{photos}} {{engine_record}}",
  },
  "photo-describe": { text: "test prompt photo-describe" },
};

// The fake source: the placeholder for each known name, version 1, label
// `production`; an unknown name is unavailable, as a missing prompt is.
export function fakePromptSource(): PromptSource {
  return {
    async get(name: string): Promise<PromptText> {
      const template = TEMPLATES[name];
      if (!template) throw new PromptUnavailable(name, "production", "no fake for this prompt");
      return { name, version: 1, label: "production", ...template };
    },
  };
}
