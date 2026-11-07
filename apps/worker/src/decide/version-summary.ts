import { readFileSync } from "node:fs";
import {
  type ChecklistOutcome,
  type EditDiff,
  type EngineNote,
  type Preset,
  askedNotDone,
  checkSummary,
  parseSummaryAnswer,
  summaryJsonSchema,
  summaryTemplate,
} from "@edit-issebya/edit";
import { type AiExchange, type AiRequest, type AiRunner, NO_USAGE } from "../ai.ts";
import type { AiUsage } from "../step-store.ts";
import { fenced } from "./prompt.ts";

// The version title and summary: one short call (the `summary` role's
// model), after layout, from the saved difference. Bump with every change to
// summary.md.
export const SUMMARY_PROMPT_VERSION = "summary-7";

// eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed prompt
const TEMPLATE = readFileSync(new URL("./summary.md", import.meta.url), "utf8");

export interface SummaryInput {
  request: string | null;
  checklist: readonly ChecklistOutcome[];
  diff: EditDiff;
  record: readonly EngineNote[];
  // The owner's library photos, to name the photos in the difference by
  // their description; none given, none named.
  library?: readonly { id: string; description: string }[];
}

// A text left in place at low contrast (`low-contrast`, or an older record's
// `shadowed`) is no change the viewer sees, so the summary never reads it.
const NOT_A_CHANGE: ReadonlySet<string> = new Set(["low-contrast", "shadowed"]);

// The summary prompt: the committed instructions with the request, the
// checklist, the difference, the rules switched and the engine record (its
// items, actions and reasons, without the low-contrast notes) quoted as
// fenced JSON data, with the description of each library photo the
// difference names.
export function summaryPrompt(input: SummaryInput): string {
  const values: Record<string, string> = {
    request: fenced(input.request ?? "(none)"),
    checklist: fenced(input.checklist),
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
  };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
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
  request,
  checklist,
  diff,
  record,
  library,
  preset,
  reelId,
  signal,
  log = console.log,
  trace,
}: SummaryInput & {
  ai: AiRunner;
  preset: Preset;
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
    log(`decide: summary from the template, reel ${reelId}: ${why} (${SUMMARY_PROMPT_VERSION})`);
    return {
      ...summaryTemplate(diff, record, checklist, preset),
      source: "template",
      usage,
      exchange,
    };
  };
  if (diff.items.length === 0 && diff.rules.length === 0) {
    return {
      ...summaryTemplate(diff, record, checklist, preset),
      source: "template",
      usage: NO_USAGE,
      exchange: null,
    };
  }
  let result;
  try {
    result = await ai.call({
      role: "summary",
      prompt: summaryPrompt({ request, checklist, diff, record, ...(library ? { library } : {}) }),
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
  const checked = checkSummary(answer, diff, preset, askedNotDone(record, checklist));
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
