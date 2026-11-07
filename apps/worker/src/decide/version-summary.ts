import {
  type EditDiff,
  type EngineNote,
  type Preset,
  checkSummary,
  parseSummaryAnswer,
  summaryJsonSchema,
  summaryTemplate,
} from "@edit-issebya/edit";
import { type AiExchange, type AiRequest, type AiRunner, NO_USAGE } from "../ai.ts";
import {
  type PromptCall,
  type PromptText,
  promptIdentity,
  renderPrompt,
} from "../prompts/source.ts";
import type { AiUsage } from "../step-store.ts";
import { fenced } from "./prompt.ts";

// The version title and summary: one short call (the `summary` role's
// model), after layout, from the saved difference. Its prompt is the fetched
// `reel-version-summary`.

export interface SummaryInput {
  diff: EditDiff;
  record: readonly EngineNote[];
  // The owner's library photos, to name the photos in the difference by
  // their description; none given, none named.
  library?: readonly { id: string; description: string }[];
}

// A text left in place at low contrast (`low-contrast`, or an older record's
// `shadowed`) is no change the viewer sees, so the summary never reads it.
const NOT_A_CHANGE: ReadonlySet<string> = new Set(["low-contrast", "shadowed"]);

// The summary prompt: the fetched template with the difference, the rules
// switched and the engine record (its items, actions and reasons, without the
// low-contrast notes) as fenced JSON data, and the description of each library
// photo the difference names.
export function summaryPrompt(template: PromptText, input: SummaryInput): PromptCall {
  return renderPrompt(template, {
    difference: fenced(input.diff.items),
    rules_changed: fenced(input.diff.rules),
    photos: fenced(
      (input.library ?? [])
        .filter((photo) => input.diff.items.some((item) => item.photo_id === photo.id))
        .map(({ id, description }) => ({ id, description })),
    ),
    engine_record: fenced(
      input.record
        .filter(({ action }) => !NOT_A_CHANGE.has(action))
        .map(({ item, action, reason }) => ({ item, action, reason })),
    ),
  });
}

export interface VersionSummary {
  title: string;
  summary: string;
  source: "ai" | "template";
  usage: AiUsage;
  // The call as sent and answered; null when no call was made or it threw.
  exchange: AiExchange | null;
}

// The title and summary of a new version. An empty difference makes no call.
// Otherwise one call, never retried: an answer that parses and passes the
// safeguard is used; anything else (broken, unavailable, refused, thrown)
// gives the code template and a log line with the reasons, never the AI's
// text. It never fails the step and never makes the job wait; only a cancel
// (the aborted signal) is rethrown.
export async function writeVersionSummary({
  ai,
  diff,
  record,
  library,
  preset,
  reelId,
  signal,
  log = console.log,
  trace,
  prompt,
}: SummaryInput & {
  ai: AiRunner;
  preset: Preset;
  // The fetched `reel-version-summary` prompt.
  prompt: PromptText;
  reelId: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
  // The call's `chat` span goes under this span; without it the call is not traced.
  trace?: AiRequest["trace"];
}): Promise<VersionSummary> {
  const template = (
    why: string,
    usage: AiUsage,
    exchange: AiExchange | null = null,
  ): VersionSummary => {
    log(`decide: summary from the template, reel ${reelId}: ${why} (${promptIdentity(prompt)})`);
    return {
      ...summaryTemplate(diff, preset),
      source: "template",
      usage,
      exchange,
    };
  };
  if (diff.items.length === 0 && diff.rules.length === 0) {
    return {
      ...summaryTemplate(diff, preset),
      source: "template",
      usage: NO_USAGE,
      exchange: null,
    };
  }
  let result;
  try {
    result = await ai.call({
      role: "summary",
      ...summaryPrompt(prompt, { diff, record, ...(library ? { library } : {}) }),
      schema: summaryJsonSchema(),
      ...(signal ? { signal } : {}),
      ...(trace ? { trace } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return template("the call failed", NO_USAGE);
  }
  const { exchange } = result;
  if (result.kind === "unavailable") return template("unavailable", result.usage, exchange);
  if (result.kind === "broken") return template("answer-json", result.usage, exchange);
  const parsed = parseSummaryAnswer(result.answer);
  if (!parsed.ok) return template("answer-schema", result.usage, exchange);
  const answer = {
    change_title: parsed.answer.change_title.trim(),
    change_summary: parsed.answer.change_summary.trim(),
  };
  const checked = checkSummary(answer, diff, preset);
  if (!checked.ok) {
    return template(`safeguard: ${checked.reasons.join("; ")}`, result.usage, exchange);
  }
  if (answer.change_title === "" || answer.change_summary === "") {
    return template("answer-schema", result.usage, exchange);
  }
  return {
    title: answer.change_title,
    summary: answer.change_summary,
    source: "ai",
    usage: result.usage,
    exchange,
  };
}
