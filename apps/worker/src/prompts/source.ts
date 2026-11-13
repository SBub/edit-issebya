import { TransientError } from "../failure.ts";

// The prompts the worker's AI calls send. Their text lives only in PostHog
// prompt management (app_docs/decide-step.md, "Prompts"); the worker fetches
// each one by name and label, and never keeps a copy in the repository.
export const PROMPT_NAMES = {
  hook: "reel-hook",
  components: "reel-components",
  describe: "photo-describe",
} as const;

// One prompt as PostHog serves it: the text (a system message, or still a
// template with `{{variables}}`, see `renderPrompt`) and the version the label
// points to.
export interface PromptText {
  name: string;
  version: number;
  label: string;
  text: string;
  // Set only on a copy served after PostHog did not answer: the last copy this
  // process fetched, at most an hour old (app_docs/decide-step.md, "Prompts").
  stale?: true;
  // Set only on an eval draft read from a local file (`draft:<hash>`,
  // app_docs/evals.md, "Drafts"): it has no PostHog version.
  draftId?: string;
}

// Where prompts come from: one source per worker process (it keeps its own
// fetched copies, app_docs/decide-step.md, "Prompts").
export interface PromptSource {
  get(name: string): Promise<PromptText>;
}

// Which prompt a call ran: what an AI generation event names
// (app_docs/measurement.md, "AI generations").
export interface PromptRef {
  name: string;
  version: number;
  label: string;
  draftId?: string;
}

// A prompt as an AI call takes it, and the identity the call records
// (`<name>@v<version>`). With `system`, the call sends two messages: `system`
// is the fetched text, unchanged, and `prompt` the user message with the call's
// inputs. Without it, `prompt` is the one message sent (the filled template).
export interface PromptCall {
  prompt: string;
  system?: string;
  promptVersion: string;
  promptRef: PromptRef;
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

// Whether a fetched text still is a template: it holds at least one `{{name}}`
// placeholder.
export function hasPlaceholders(text: string): boolean {
  return /\{\{\w+\}\}/.test(text);
}

const REFUSED_LINE =
  "Your previous answer was refused for these reasons. Fix them and answer again:";
// The heading of the user message's last section on a retry.
const REFUSED_HEADING = "previous_answer_refused";

// The user message: one section per input, in the order given, each a
// `## <name>` heading and the input's text (fenced JSON or plain text), then,
// on a retry, the refused reasons as the last section. Empty with no input and
// no reason (describe_photo's first call: its image is the whole message).
export function userMessage(
  values: Record<string, string>,
  previousReasons?: readonly string[],
): string {
  const sections = Object.entries(values).map(([name, text]) => `## ${name}\n\n${text}`);
  if (previousReasons && previousReasons.length > 0) {
    sections.push(
      [
        `## ${REFUSED_HEADING}`,
        "",
        REFUSED_LINE,
        ...previousReasons.map((reason) => `- ${reason}`),
      ].join("\n"),
    );
  }
  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
}

// A fetched prompt and one call's inputs, as the AI call takes them. Two paths,
// chosen by the fetched text alone (app_docs/decide-step.md, "Messages"):
//
// - No `{{name}}` placeholder in it: the text is the system message, sent
//   unchanged, and the inputs (and, on a retry, the refused reasons) are the
//   user message (`userMessage`), one section per value in the order given.
// - At least one placeholder: the template path. The placeholders are filled
//   with the values (one with no value is left as it is), the reasons appended
//   on a retry, and the filled text is the one message sent.
export function renderPrompt(
  template: PromptText,
  values: Record<string, string>,
  previousReasons?: readonly string[],
): PromptCall {
  const identity = {
    promptVersion: promptIdentity(template),
    promptRef: {
      name: template.name,
      version: template.version,
      label: template.label,
      ...(template.draftId ? { draftId: template.draftId } : {}),
    },
    ...(template.stale ? { promptStale: true as const } : {}),
  };
  if (!hasPlaceholders(template.text)) {
    return { prompt: userMessage(values, previousReasons), system: template.text, ...identity };
  }
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
          REFUSED_LINE,
          ...previousReasons.map((reason) => `- ${reason}`),
          "",
        ].join("\n");
  return { prompt, ...identity };
}

// The two decide prompts, fetched together before the decide step's first AI
// call, so a PostHog failure costs no AI call.
export async function decidePrompts(source: PromptSource): Promise<{
  hook: PromptText;
  components: PromptText;
}> {
  const [hook, components] = await Promise.all([
    source.get(PROMPT_NAMES.hook),
    source.get(PROMPT_NAMES.components),
  ]);
  return { hook, components };
}
