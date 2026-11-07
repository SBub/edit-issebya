import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { posthogPromptSource } from "./posthog-source.ts";
import type { PromptSource } from "./source.ts";

// The worker's prompt source: the placeholder prompts when E2E_MOCK_PROMPTS is
// exactly "true" (the E2E double, app_docs/decide-step.md), else PostHog. The
// caller keeps the result for the whole process (one source, one cache).
export function promptSourceOf(
  env: Record<string, string | undefined> = process.env,
): PromptSource {
  if (env.E2E_MOCK_PROMPTS === "true") return fakePromptSource();
  return posthogPromptSource(env);
}
