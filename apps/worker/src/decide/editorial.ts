import {
  type Context,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type Span,
  trace,
} from "@opentelemetry/api";
import {
  type DecideAnswer,
  type Edit,
  type EngineNote,
  type FreeSentence,
  type Preset,
  type Transcript,
  type UnplacedItem,
  WHY_WORDS,
  editorialJsonSchema,
  mergeEditorial,
  parseEditorialAnswer,
  wordsText,
} from "@edit-issebya/edit";
import { type AiExchange, type AiRunner, NO_USAGE } from "../ai.ts";
import { type PromptCall, type PromptText, renderPrompt } from "../prompts/source.ts";
import { type AiUsage, addUsage } from "../step-store.ts";
import type { InSpan, Telemetry } from "../telemetry.ts";
import { fenced } from "./prompt.ts";

// How many editorial rounds a decide may make: one, and only when a left-out
// item has a sentence with room for its kind.
export const EDITORIAL_ROUNDS = 1;

// One placement of an answer, as the rounds read it.
export interface Placed {
  edit: Edit;
  record: EngineNote[];
  unplaced: UnplacedItem[];
  free: FreeSentence[];
}

export interface EditorialInput {
  items: {
    item: string;
    kind: UnplacedItem["kind"];
    words: string;
    why: string;
  }[];
  free: { from: string; to: string; text: string; room_for: FreeSentence["room_for"] }[];
}

// The round's input in editor terms: the items left out (the words they were
// on, why in words) and the sentences with room for their kinds. No time,
// size or spot.
export function editorialInput({
  items,
  free,
  transcript,
  preset,
}: {
  items: readonly UnplacedItem[];
  free: readonly FreeSentence[];
  transcript: Transcript;
  preset: Preset;
}): EditorialInput {
  const ids = transcript.words.map((word) => word.id);
  const text = (from: string, to: string) =>
    wordsText(ids.slice(ids.indexOf(from), ids.indexOf(to) + 1), transcript, preset);
  const kinds = new Set(items.map((item) => item.kind));
  return {
    items: items.map((item) => ({
      item: item.ref,
      kind: item.kind,
      words: text(item.from, item.to),
      why: WHY_WORDS[item.why],
    })),
    free: free
      .map((sentence) => ({
        from: sentence.from,
        to: sentence.to,
        text: text(sentence.from, sentence.to),
        room_for: sentence.room_for.filter((kind) => kinds.has(kind)),
      }))
      .filter((sentence) => sentence.room_for.length > 0),
  };
}

// The editorial prompt: the fetched template (`reel-editorial`) with the input
// as fenced JSON.
export function editorialPrompt(template: PromptText, input: EditorialInput): PromptCall {
  return renderPrompt(template, {
    items: fenced(input.items),
    free: fenced(input.free),
  });
}

export interface EditorialRun {
  ai: AiRunner;
  // The fetched `reel-editorial` prompt.
  editorial: PromptText;
  // The job's signal: a lost lease stops a round's call.
  signal?: AbortSignal;
  transcript: Transcript;
  preset: Preset;
  // The merged answer checked again (the decide answer's own rules).
  check: (json: unknown) => { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] };
  // The whole answer placed again, under the round's span context; null when
  // the engine's output does not parse (an engine bug: the rounds end).
  place: (answer: DecideAnswer, context: Context) => Placed | null | Promise<Placed | null>;
  // Runs each round in a span of its own (decide's spans); without it, none.
  inRound?: InSpan;
  // Each round's AI call is a `chat` span under the round's span, recorded
  // with this telemetry; without it the calls are not traced.
  telemetry?: Telemetry;
  answer: DecideAnswer;
  placed: Placed;
}

export interface EditorialResult {
  answer: DecideAnswer;
  placed: Placed;
  // The rounds' notes (rule `editorial`), for the engine record.
  notes: EngineNote[];
  rounds: number;
  usage: AiUsage;
  // Each round's call as sent and answered, for the version's AI record.
  exchanges: AiExchange[];
  // Why the rounds ended early (a refused or broken answer, the AI not
  // available); null when they ran their course.
  ended: string | null;
}

// The editorial round after a placed answer: the items left out that have a
// sentence with room for their kind go to the editor, who makes one meaning
// choice for each; the merged answer is placed again in full. A broken or
// refused editorial answer, a merged answer the decide rules refuse, or the
// AI not being available ends the round and keeps the placement before it:
// never a retry, never a failed step, never a wait.
export async function runEditorialRounds(run: EditorialRun): Promise<EditorialResult> {
  const cap = EDITORIAL_ROUNDS;
  let answer = run.answer;
  let placed = run.placed;
  let usage = NO_USAGE;
  const notes: EngineNote[] = [];
  const exchanges: AiExchange[] = [];
  let rounds = 0;
  const end = (ended: string): EditorialResult => ({
    answer,
    placed,
    notes,
    rounds,
    usage,
    exchanges,
    ended,
  });
  // One round: its AI call and the placement of the merged answer. Returns
  // why the rounds end, or null to go on.
  const oneRound = async (
    items: readonly UnplacedItem[],
    span: Span,
    context: Context,
  ): Promise<string | null> => {
    const result = await run.ai.call({
      role: "editorial",
      ...editorialPrompt(
        run.editorial,
        editorialInput({
          items,
          free: placed.free,
          transcript: run.transcript,
          preset: run.preset,
        }),
      ),
      schema: editorialJsonSchema(run.transcript, items),
      ...(run.signal ? { signal: run.signal } : {}),
      ...(run.telemetry ? { trace: { telemetry: run.telemetry, parent: context } } : {}),
    });
    rounds += 1;
    usage = addUsage(usage, result.usage);
    exchanges.push(result.exchange);
    if (result.kind === "unavailable") {
      span.setAttribute("decide.outcome", "unavailable");
      return `the AI is not available: ${result.reason}`;
    }
    if (result.kind === "broken") {
      span.setAttribute("decide.outcome", "invalid");
      return `the editorial answer was not valid JSON: ${result.reason}`;
    }
    const parsed = parseEditorialAnswer(result.answer, run.transcript, items);
    if (!parsed.ok) {
      span.setAttribute("decide.outcome", "refused");
      return `the editorial answer was refused: ${parsed.reasons.join("; ")}`;
    }
    const merged = mergeEditorial(answer, parsed.answer, items, run.transcript, run.preset);
    const checked = run.check(merged.answer);
    if (!checked.ok) {
      span.setAttribute("decide.outcome", "refused");
      return `the merged answer was refused: ${checked.reasons.join("; ")}`;
    }
    const again = await run.place(checked.answer, context);
    if (!again) {
      span.setAttribute("decide.outcome", "not_placed");
      return "the merged answer could not be placed";
    }
    span.setAttribute("decide.outcome", "placed");
    answer = checked.answer;
    placed = again;
    notes.push(...merged.notes);
    return null;
  };

  while (rounds < cap) {
    const hasRoom = (item: UnplacedItem) =>
      placed.free.some((sentence) => sentence.room_for.includes(item.kind));
    const items = placed.unplaced.filter((item) => rounds === 0 && hasRoom(item));
    if (items.length === 0) break;
    const round = rounds + 1;
    const ended = run.inRound
      ? await run.inRound("decide.editorial_round", { "decide.round": round }, (span, context) =>
          oneRound(items, span, context),
        )
      : await oneRound(items, trace.wrapSpanContext(INVALID_SPAN_CONTEXT), ROOT_CONTEXT);
    if (ended !== null) return end(ended);
  }
  return { answer, placed, notes, rounds, usage, exchanges, ended: null };
}
