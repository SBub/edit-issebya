import { readFileSync } from "node:fs";
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
import type { AiRunner } from "../ai.ts";
import { AiUnavailable } from "../failure.ts";
import type { Tool } from "../step-runner.ts";
import { type AiUsage, addUsage } from "../step-store.ts";
import type { LibraryEntry } from "./input.ts";
import { fenced } from "./prompt.ts";

// How many editorial rounds a decide may make: one on the automatic run (and
// only when a left-out item has a sentence with room for its kind), up to
// three on a request while an item the owner asked for is left out.
export const EDITORIAL_ROUNDS = { automatic: 1, request: 3 } as const;

// eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed prompt
const TEMPLATE = readFileSync(new URL("./editorial.md", import.meta.url), "utf8");

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
    photo?: { id: string; description: string };
    why: string;
    asked_by_owner: boolean;
  }[];
  free: { from: string; to: string; text: string; room_for: FreeSentence["room_for"] }[];
  library: LibraryEntry[];
  request: string | null;
}

// The round's input in editor terms: the items left out (the words they were
// on, why in words), the sentences with room for their kinds, the library
// (only when a photo is left out) and the request. No time, size or spot.
export function editorialInput({
  items,
  free,
  transcript,
  preset,
  library,
  request,
}: {
  items: readonly UnplacedItem[];
  free: readonly FreeSentence[];
  transcript: Transcript;
  preset: Preset;
  library: readonly LibraryEntry[];
  request: string | null;
}): EditorialInput {
  const ids = transcript.words.map((word) => word.id);
  const text = (from: string, to: string) =>
    wordsText(ids.slice(ids.indexOf(from), ids.indexOf(to) + 1), transcript, preset);
  const kinds = new Set(items.map((item) => item.kind));
  return {
    items: items.map((item) => {
      const photo = library.find((entry) => entry.id === item.photo_id);
      return {
        item: item.ref,
        kind: item.kind,
        words: text(item.from, item.to),
        ...(photo ? { photo: { id: photo.id, description: photo.description } } : {}),
        why: WHY_WORDS[item.why],
        asked_by_owner: item.requested,
      };
    }),
    free: free
      .map((sentence) => ({
        from: sentence.from,
        to: sentence.to,
        text: text(sentence.from, sentence.to),
        room_for: sentence.room_for.filter((kind) => kinds.has(kind)),
      }))
      .filter((sentence) => sentence.room_for.length > 0),
    library: kinds.has("photo")
      ? library.map(({ id, description, tags }) => ({ id, description, tags: [...tags] }))
      : [],
    request,
  };
}

// The editorial prompt: the committed instructions with the input as fenced
// JSON.
export function editorialPrompt(input: EditorialInput): string {
  const values: Record<string, string> = {
    items: fenced(input.items),
    free: fenced(input.free),
    library: fenced(input.library),
    request: input.request ?? "(none)",
  };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

export interface EditorialRun {
  ai: AiRunner;
  tool: Tool;
  cwd: string;
  transcript: Transcript;
  preset: Preset;
  library: readonly LibraryEntry[];
  photoIds: readonly string[];
  request: string | null;
  // The merged answer checked again (the decide answer's own rules).
  check: (json: unknown) => { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] };
  // The whole answer placed again; null when the engine's output does not
  // parse (an engine bug: the rounds end).
  place: (answer: DecideAnswer) => Placed | null;
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
  // Why the rounds ended early (a refused or broken answer, the AI not
  // available); null when they ran their course.
  ended: string | null;
}

const NO_USAGE: AiUsage = { inputTokens: null, outputTokens: null, costUsd: null, model: null };

// The editorial rounds after a placed answer. Each round sends the items to
// decide on (every requested item left out; in the first round also the
// others with a sentence that has room for their kind), merges the editor's
// choices into the answer and places it all again. A broken or refused
// editorial answer, or a merged answer the decide rules refuse, ends the
// rounds and keeps the placement before it: never a retry, never a failed
// step. The AI not available ends them too, except on a request while an
// item the owner asked for is left out: then the job waits.
export async function runEditorialRounds(run: EditorialRun): Promise<EditorialResult> {
  const cap = run.request === null ? EDITORIAL_ROUNDS.automatic : EDITORIAL_ROUNDS.request;
  let answer = run.answer;
  let placed = run.placed;
  let usage = NO_USAGE;
  const notes: EngineNote[] = [];
  let rounds = 0;
  const end = (ended: string): EditorialResult => ({
    answer,
    placed,
    notes,
    rounds,
    usage,
    ended,
  });
  while (rounds < cap) {
    const hasRoom = (item: UnplacedItem) =>
      placed.free.some((sentence) => sentence.room_for.includes(item.kind));
    const items = placed.unplaced.filter(
      (item) => (run.request !== null && item.requested) || (rounds === 0 && hasRoom(item)),
    );
    if (items.length === 0) break;
    const result = await run.ai.call(run.tool, {
      prompt: editorialPrompt(
        editorialInput({
          items,
          free: placed.free,
          transcript: run.transcript,
          preset: run.preset,
          library: run.library,
          request: run.request,
        }),
      ),
      schema: editorialJsonSchema(run.transcript, items, run.photoIds),
      cwd: run.cwd,
    });
    rounds += 1;
    usage = addUsage(usage, result.usage);
    if (result.kind === "unavailable") {
      if (run.request !== null && placed.unplaced.some((item) => item.requested)) {
        throw new AiUnavailable(result.reason);
      }
      return end(`the AI is not available: ${result.reason}`);
    }
    if (result.kind === "broken")
      return end(`the editorial answer was not valid JSON: ${result.reason}`);
    const parsed = parseEditorialAnswer(result.answer, run.transcript, items, run.photoIds);
    if (!parsed.ok) return end(`the editorial answer was refused: ${parsed.reasons.join("; ")}`);
    const merged = mergeEditorial(answer, parsed.answer, items, run.transcript, run.preset);
    const checked = run.check(merged.answer);
    if (!checked.ok) return end(`the merged answer was refused: ${checked.reasons.join("; ")}`);
    const again = run.place(checked.answer);
    if (!again) return end("the merged answer could not be placed");
    answer = checked.answer;
    placed = again;
    notes.push(...merged.notes);
  }
  return { answer, placed, notes, rounds, usage, ended: null };
}
