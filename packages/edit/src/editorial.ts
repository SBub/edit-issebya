import { z } from "zod";
import type { DecideAnswer } from "./decide.ts";
import type { EngineNote, UnplacedItem, UnplacedWhy } from "./engine.ts";
import { wordsText } from "./layout.ts";
import type { Preset } from "./preset.ts";
import { issueReasons } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// THE EDITORIAL ROUND. After the answer is placed, what the engine left out
// goes back to the editor (Claude) in editor terms: which item, on which
// words, why in words, and the sentences with room for its kind. The editor
// makes one meaning choice per item: other words, or skip with a reason for
// the owner. Never a time, a position, a size or a spot. The choice is merged
// into the answer, which is placed again in full.

const MAX_WHY = 300;

// The editorial answer, per reel and per round: one choice for each left-out
// item, by its answer reference. The refinement (dropped from the JSON
// Schema) refuses an item missing or chosen twice, a skip without its reason
// or with words, a choice without words or ending before it starts, and a big
// word on more than one word.
export function editorialAnswerSchemaFor(
  transcript: Transcript,
  unplaced: readonly UnplacedItem[],
) {
  const ids = transcript.words.map((word) => word.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const refs = unplaced.map((item) => item.ref);
  const wordId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
  const item = refs.length > 0 ? z.enum(refs as [string, ...string[]]) : z.never();
  return z
    .strictObject({
      choices: z
        .array(
          z.strictObject({
            item,
            // True: the item is left out; `why` says why and what the owner
            // can do. False: `from` and `to` name its new words.
            skip: z.boolean(),
            from: wordId.optional(),
            to: wordId.optional(),
            why: z.string().min(1).max(MAX_WHY).optional(),
          }),
        )
        .max(Math.max(1, refs.length)),
    })
    .superRefine((answer, ctx) => {
      const seen = new Set<string>();
      answer.choices.forEach((choice, index) => {
        const path = ["choices", index];
        if (seen.has(choice.item)) {
          ctx.addIssue({ code: "custom", path, message: `${choice.item} is chosen twice` });
        }
        seen.add(choice.item);
        const left = unplaced.find((entry) => entry.ref === choice.item);
        if (choice.skip) {
          if (choice.why === undefined) {
            ctx.addIssue({
              code: "custom",
              path: [...path, "why"],
              message: "a skip says why, in plain words for the owner",
            });
          }
          if (choice.from !== undefined || choice.to !== undefined) {
            ctx.addIssue({
              code: "custom",
              path,
              message: "a skip names no words",
            });
          }
          return;
        }
        if (choice.from === undefined || choice.to === undefined) {
          ctx.addIssue({
            code: "custom",
            path,
            message: "a choice that is not a skip names its words with from and to",
          });
          return;
        }
        if (order.get(choice.to)! < order.get(choice.from)!) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "to"],
            message: `ends on ${choice.to}, before it starts on ${choice.from}`,
          });
        }
        if (left?.kind === "big_word" && choice.from !== choice.to) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "to"],
            message: "a big word is one word: from and to are the same",
          });
        }
      });
      for (const ref of refs) {
        if (!seen.has(ref)) {
          ctx.addIssue({
            code: "custom",
            path: ["choices"],
            message: `no choice for ${ref}: make one for every item`,
          });
        }
      }
    });
}

export type EditorialAnswer = z.infer<ReturnType<typeof editorialAnswerSchemaFor>>;

// The editorial answer's JSON Schema for the AI's structured output: the same draft-07
// settings as the decide answer's.
export function editorialJsonSchema(
  transcript: Transcript,
  unplaced: readonly UnplacedItem[],
): Record<string, unknown> {
  return z.toJSONSchema(editorialAnswerSchemaFor(transcript, unplaced), {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

export function parseEditorialAnswer(
  json: unknown,
  transcript: Transcript,
  unplaced: readonly UnplacedItem[],
): { ok: true; answer: EditorialAnswer } | { ok: false; reasons: string[] } {
  const result = editorialAnswerSchemaFor(transcript, unplaced).safeParse(json);
  if (result.success) return { ok: true, answer: result.data };
  return { ok: false, reasons: issueReasons(json, result.error.issues) };
}

// Why an item was left out, in the words the owner and the editor read.
export const WHY_WORDS: Record<UnplacedWhy, string> = {
  "no-room": "no room on its sentence",
  busy: "another extra shows then",
  "too-short": "its sentence is too short",
  hidden: "the footage is hidden there",
};

// An item by its id, in plain words: `visual 1`, `accent 2`, `big word 1`,
// `the title` (`big-word` alone: an older version's one big word).
function itemLabel(id: string): string {
  if (id === "title") return "the title";
  if (id === "big-word") return "the big word";
  return id.replaceAll("-", " ");
}

// The answer with the editor's choices applied: each chosen item's words
// replaced in place, each skipped item removed from its list (with the
// round's notes, rule `editorial`). The worker checks the merged answer again
// with `parseDecideAnswer`.
export function mergeEditorial(
  answer: DecideAnswer,
  editorial: EditorialAnswer,
  unplaced: readonly UnplacedItem[],
  transcript: Transcript,
  preset: Preset,
): { answer: DecideAnswer; notes: EngineNote[] } {
  const ids = transcript.words.map((word) => word.id);
  const text = (from: string, to: string) =>
    wordsText(ids.slice(ids.indexOf(from), ids.indexOf(to) + 1), transcript, preset);
  const notes: EngineNote[] = [];
  const accents = [...answer.accents];
  const visuals = [...answer.visuals];
  const bigWords = [...answer.big_words];
  const skipped = new Set<string>();
  for (const choice of editorial.choices) {
    const left = unplaced.find((item) => item.ref === choice.item);
    if (!left) continue;
    const label = itemLabel(left.id);
    if (choice.skip) {
      skipped.add(choice.item);
      notes.push({
        item: left.id,
        action: "dropped",
        rule: "editorial",
        reason: `the editor left out ${label}: ${choice.why!}`,
      });
      continue;
    }
    const from = choice.from!;
    const to = choice.to!;
    const index = Number(/\d+/.exec(choice.item)?.[0] ?? 0);
    if (left.kind === "accent") {
      accents[index] = { ...accents[index]!, from, to };
    } else if (left.kind === "visual") {
      visuals[index] = { ...visuals[index]!, from, to };
    } else {
      const big = bigWords[index];
      if (big) bigWords[index] = { ...big, word: from };
    }
    notes.push({
      item: left.id,
      action: "moved",
      rule: "editorial",
      reason: `the editor moved ${label} to ${JSON.stringify(text(from, to))} (${from} to ${to}): ${WHY_WORDS[left.why]}`,
    });
  }

  // The lists without the skipped items (`accents[0]`, `visuals[1]`, ...).
  const keep = <T>(list: readonly T[], name: string) =>
    list.filter((_, index) => !skipped.has(`${name}[${index}]`));
  return {
    answer: {
      ...answer,
      accents: keep(accents, "accents"),
      visuals: keep(visuals, "visuals"),
      big_words: keep(bigWords, "big_words"),
    },
    notes,
  };
}

// One ask of a request as stored with a version written before the change
// box was removed: what was asked, what would satisfy it, the items linked,
// whether the version does it and, when not, the reason. Read back only;
// no version is written with a checklist any more.
export interface ChecklistOutcome {
  ask: string;
  wants: string;
  fulfilled_by: string[];
  done: boolean;
  reason: string | null;
}
