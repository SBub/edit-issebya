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
// makes one meaning choice per item: other words (and, for a photo, maybe
// another library photo), or skip with a reason for the owner. Never a time,
// a position, a size or a spot. The choice is merged into the answer, which
// is placed again in full.

const MAX_WHY = 300;

// The editorial answer, per reel and per round: one choice for each left-out
// item, by its answer reference. The refinement (dropped from the JSON
// Schema) refuses an item missing or chosen twice, a skip without its reason
// or with words, a choice without words or ending before it starts, a big
// word on more than one word, and a photo id on anything but a photo.
export function editorialAnswerSchemaFor(
  transcript: Transcript,
  unplaced: readonly UnplacedItem[],
  photoIds: readonly string[] = [],
) {
  const ids = transcript.words.map((word) => word.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const refs = unplaced.map((item) => item.ref);
  const wordId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
  const photoId = photoIds.length > 0 ? z.enum(photoIds as [string, ...string[]]) : z.never();
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
            photo_id: photoId.optional(),
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
          if (
            choice.from !== undefined ||
            choice.to !== undefined ||
            choice.photo_id !== undefined
          ) {
            ctx.addIssue({
              code: "custom",
              path,
              message: "a skip names no words and no photo",
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
        if (choice.photo_id !== undefined && left?.kind !== "photo") {
          ctx.addIssue({
            code: "custom",
            path: [...path, "photo_id"],
            message: `${choice.item} is not a photo`,
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

// The editorial answer's JSON Schema for `--json-schema`: the same draft-07
// settings as the decide answer's.
export function editorialJsonSchema(
  transcript: Transcript,
  unplaced: readonly UnplacedItem[],
  photoIds: readonly string[] = [],
): Record<string, unknown> {
  return z.toJSONSchema(editorialAnswerSchemaFor(transcript, unplaced, photoIds), {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

export function parseEditorialAnswer(
  json: unknown,
  transcript: Transcript,
  unplaced: readonly UnplacedItem[],
  photoIds: readonly string[] = [],
): { ok: true; answer: EditorialAnswer } | { ok: false; reasons: string[] } {
  const result = editorialAnswerSchemaFor(transcript, unplaced, photoIds).safeParse(json);
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

// An item by its id, in plain words: `photo 1`, `accent 2`, `big word 1`,
// `the title` (`big-word` alone: an older version's one big word).
function itemLabel(id: string): string {
  if (id === "title") return "the title";
  if (id === "big-word") return "the big word";
  return id.replaceAll("-", " ");
}

// The answer with the editor's choices applied: each chosen item's words
// (and photo) replaced in place, each skipped item removed with the
// checklist's links re-indexed (a link to it removed; an ask left with no
// link carries the editor's reason as its `why_not`). With the round's
// notes (rule `editorial`). The worker checks the merged answer again with
// `parseDecideAnswer`.
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
  const photos = [...answer.photos];
  const bigWords = [...answer.big_words];
  const skipped = new Map<string, string>();
  for (const choice of editorial.choices) {
    const left = unplaced.find((item) => item.ref === choice.item);
    if (!left) continue;
    const label = itemLabel(left.id);
    if (choice.skip) {
      skipped.set(choice.item, choice.why!);
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
    let another = false;
    if (left.kind === "accent") {
      accents[index] = { ...accents[index]!, from, to };
    } else if (left.kind === "photo") {
      const photo = photos[index]!;
      another = choice.photo_id !== undefined && choice.photo_id !== photo.photo_id;
      photos[index] = { ...photo, from, to, photo_id: choice.photo_id ?? photo.photo_id };
    } else {
      const big = bigWords[index];
      if (big) bigWords[index] = { ...big, word: from };
    }
    notes.push({
      item: left.id,
      action: "moved",
      rule: "editorial",
      reason: `the editor moved ${label} to ${JSON.stringify(text(from, to))} (${from} to ${to})${another ? " with another photo" : ""}: ${WHY_WORDS[left.why]}`,
    });
  }

  // Re-index the lists without the skipped items.
  const keep = <T>(list: readonly T[], name: string) => {
    const map = new Map<number, number>();
    const out: T[] = [];
    list.forEach((item, index) => {
      if (skipped.has(`${name}[${index}]`)) return;
      map.set(index, out.length);
      out.push(item);
    });
    return { out, map };
  };
  const kept = {
    accents: keep(accents, "accents"),
    big_words: keep(bigWords, "big_words"),
    photos: keep(photos, "photos"),
  };
  const relink = (ref: string): string | null => {
    if (skipped.has(ref)) return null;
    const list = /^(accents|big_words|photos)\[(\d+)\]$/.exec(ref);
    if (!list) return ref;
    const to = kept[list[1] as keyof typeof kept].map.get(Number(list[2]));
    return to === undefined ? null : `${list[1]}[${to}]`;
  };
  const checklist = answer.checklist.map((entry) => {
    const links = entry.fulfilled_by.map(relink).filter((ref): ref is string => ref !== null);
    const lost = entry.fulfilled_by
      .filter((ref) => skipped.has(ref))
      .map((ref) => skipped.get(ref)!);
    const whyNot = entry.why_not ?? (links.length === 0 ? lost[0] : undefined);
    const next = { ...entry, fulfilled_by: links };
    if (whyNot !== undefined) next.why_not = whyNot;
    return next;
  });
  return {
    answer: {
      ...answer,
      accents: kept.accents.out,
      photos: kept.photos.out,
      big_words: kept.big_words.out,
      checklist,
    },
    notes,
  };
}

// One ask of the request as stored with its version: what was asked, what
// would satisfy it, the items linked, whether the version does it and, when
// not, the exact reason and what the owner can do.
export interface ChecklistOutcome {
  ask: string;
  wants: string;
  fulfilled_by: string[];
  done: boolean;
  reason: string | null;
}

// What the owner can do about an item of each kind left out.
const OWNER_CAN: Record<UnplacedItem["kind"], string> = {
  photo: "ask for it on another sentence or add a photo that matches another part",
  accent: "ask for it on another sentence",
  big_word: "ask for it on another sentence",
};

// What the owner can do about a transition left out.
const OWNER_CAN_TRANSITION = "ask for it on another phrase, or for fewer transitions";

// The final checklist against the final placement. An ask is done when
// every item it links is in the version (`behind_rules` and word fixes always
// are; a transition when the engine kept it). Otherwise its reason is each
// left-out item's drop (from the engine's record) and what the owner can do;
// with no link, the answer's `why_not` (or the editor's skip reason), else a
// plain default.
export function checklistOutcome(
  checklist: DecideAnswer["checklist"],
  placement: { unplaced: readonly UnplacedItem[]; record: readonly EngineNote[] },
): ChecklistOutcome[] {
  return checklist.map((entry) => {
    const base = { ask: entry.ask, wants: entry.wants, fulfilled_by: [...entry.fulfilled_by] };
    if (entry.fulfilled_by.length === 0) {
      return { ...base, done: false, reason: entry.why_not ?? "nothing in this version does it" };
    }
    const missing = entry.fulfilled_by
      .map((ref) => placement.unplaced.find((item) => item.ref === ref))
      .filter((item): item is UnplacedItem => item !== undefined);
    // A linked transition the engine dropped (by its timing, the rate, an
    // overlap or no room for its text).
    const droppedTransitions = entry.fulfilled_by.flatMap((ref) => {
      const index = /^transitions\[(\d+)\]$/.exec(ref)?.[1];
      if (index === undefined) return [];
      const id = `transition-${Number(index) + 1}`;
      const drop = placement.record.findLast(
        (note) => note.item === id && (note.action === "dropped" || note.action === "removed"),
      );
      return drop ? [`${drop.reason}; ${OWNER_CAN_TRANSITION}`] : [];
    });
    if (missing.length === 0 && droppedTransitions.length === 0) {
      return { ...base, done: true, reason: null };
    }
    const reasons = missing.map((item) => {
      const drop = placement.record.findLast(
        (note) => note.item === item.id && note.action === "dropped",
      );
      const why = drop ? drop.reason : `${itemLabel(item.id)}: ${WHY_WORDS[item.why]}`;
      return `${why}; ${OWNER_CAN[item.kind]}`;
    });
    return { ...base, done: false, reason: [...reasons, ...droppedTransitions].join(". ") };
  });
}
