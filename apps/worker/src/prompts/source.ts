import { TransientError } from "../failure.ts";

// The prompts the worker's AI calls send. Their text lives only in PostHog
// prompt management (app_docs/decide-step.md, "Prompts"); the worker fetches
// each one by name and label, and never keeps a copy in the repository.
export const PROMPT_NAMES = {
  hook: "reel-hook",
  components: "reel-components",
  editorial: "reel-editorial",
  summary: "reel-version-summary",
  describe: "photo-describe",
} as const;

// One prompt as PostHog serves it: the template with its `{{variables}}`, the
// version the label points to, and the temperature stored with that version.
export interface PromptText {
  name: string;
  version: number;
  label: string;
  text: string;
  temperature: number;
  // Set only on a copy served after PostHog did not answer: the last copy this
  // process fetched, at most an hour old (app_docs/decide-step.md, "Prompts").
  stale?: true;
}

// Where prompts come from: one source per worker process (it keeps its own
// fetched copies, app_docs/decide-step.md, "Prompts").
export interface PromptSource {
  get(name: string): Promise<PromptText>;
}

// A filled prompt as an AI call takes it: the text, the identity the call
// records (`<name>@v<version>`) and the temperature the call runs at.
export interface PromptCall {
  prompt: string;
  promptVersion: string;
  temperature: number;
  // Set only when the prompt is a stale copy: the call records it.
  promptStale?: true;
}

// The prompt could not be fetched (PostHog unreachable, the prompt or its label
// missing, the key not set). Transient: the step fails and may be retried, and
// no AI call has been made yet.
export class PromptUnavailable extends TransientError {
  constructor(name: string, label: string, reason: string) {
    super(`prompts: ${name} (label ${label}) could not be fetched: ${reason}`);
    this.name = "PromptUnavailable";
  }
}

// `<name>@v<version>`, the identity every AI record, version row, photo row and
// telemetry attribute carries.
export function promptIdentity(prompt: Pick<PromptText, "name" | "version">): string {
  return `${prompt.name}@v${prompt.version}`;
}

// The label the worker fetches by: POSTHOG_PROMPT_LABEL, else `production`.
export function promptLabel(env: Record<string, string | undefined>): string {
  return env.POSTHOG_PROMPT_LABEL?.trim() || "production";
}

// Fills `{{name}}` placeholders with the values (a placeholder with no value is
// left as it is), then, on a retry, appends the reasons the previous answer was
// refused. The filled text, its identity and its temperature for the AI call.
export function renderPrompt(
  template: PromptText,
  values: Record<string, string>,
  previousReasons?: readonly string[],
): PromptCall {
  const filled = template.text.replace(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => values[name] ?? match,
  );
  const prompt =
    !previousReasons || previousReasons.length === 0
      ? filled
      : [
          filled.trimEnd(),
          "",
          "Your previous answer was refused for these reasons. Fix them and answer again:",
          ...previousReasons.map((reason) => `- ${reason}`),
          "",
        ].join("\n");
  return {
    prompt,
    promptVersion: promptIdentity(template),
    temperature: template.temperature,
    ...(template.stale ? { promptStale: true as const } : {}),
  };
}

// The four decide prompts, fetched together before the decide step's first AI
// call, so a PostHog failure costs no AI call.
export async function decidePrompts(source: PromptSource): Promise<{
  hook: PromptText;
  components: PromptText;
  editorial: PromptText;
  summary: PromptText;
}> {
  const [hook, components, editorial, summary] = await Promise.all([
    source.get(PROMPT_NAMES.hook),
    source.get(PROMPT_NAMES.components),
    source.get(PROMPT_NAMES.editorial),
    source.get(PROMPT_NAMES.summary),
  ]);
  return { hook, components, editorial, summary };
}
