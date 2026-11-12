import { z } from "zod";

// THE OWNER'S MARKS: one hand-labelled reel of the PostHog dataset
// (app_docs/evals.md), read into word-index spans on the reel's transcript, so
// a curator pick (word ids) and an owner mark (seconds and words) compare by
// the words they cover.

// The components the eval scores. VISUAL and the hook are not scored yet.
export const COMPONENTS = ["accent", "bigword", "list", "question"] as const;
export type Component = (typeof COMPONENTS)[number];

// Words `from` to `to` of the transcript, both included (indexes, not ids).
export interface Span {
  from: number;
  to: number;
}

// One pick of a component: the words it covers, and for a LIST its items.
export interface ComponentPick {
  component: Component;
  span: Span;
  items?: Span[];
}

// An owner mark: a pick, and for a LIST its level (`phrases` or `sections`).
export interface OwnerMark extends ComponentPick {
  level?: string;
}

export interface EvalWord {
  text: string;
  start: number;
  end: number;
}

export interface OwnerItem {
  // The dataset item and the version of it this run read.
  id: string;
  versionId: string;
  // The stable case name across runs: the item's client id, else its id.
  caseKey: string;
  // The reel the owner labelled (`metadata.reel_id`, the start of its uuid).
  reelId: string;
  words: EvalWord[];
  marks: OwnerMark[];
  // The spans the owner marked as holding nothing (a setup line).
  nothing: Span[];
}

const markSchema = z.object({
  start: z.number(),
  end: z.number(),
  words: z.string().optional(),
});
type RawMark = z.infer<typeof markSchema>;

const listSchema = markSchema.extend({
  items: z.array(markSchema).min(1),
  level: z.string().optional(),
});

const itemSchema = z.object({
  id: z.string().min(1),
  client_item_id: z.string().nullish(),
  version_id: z.string().min(1),
  input: z.object({
    transcript: z.object({
      words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).min(1),
    }),
  }),
  expected_output: z.object({
    accent: z.array(markSchema).default([]),
    bigword: z.array(markSchema).default([]),
    question: z.array(markSchema).default([]),
    list: z.array(listSchema).default([]),
    nothing: z.array(markSchema).default([]),
  }),
  metadata: z.object({ reel_id: z.string().min(1) }),
});

// A word may start or end this far outside a mark's seconds and still be in it.
const TIME_SLACK_SECONDS = 0.0005;

function tokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

// The words a mark covers. By its text first: the run of words spelling the
// mark, the one starting nearest the mark's start when the text comes back.
// Else by its seconds: every word that starts and ends inside the mark. Null
// when neither finds a word.
export function spanOfMark(words: readonly EvalWord[], mark: RawMark): Span | null {
  const wanted = tokens(mark.words ?? "");
  if (wanted.length > 0) {
    let best: Span | null = null;
    let bestGap = Infinity;
    for (let from = 0; from + wanted.length <= words.length; from += 1) {
      if (!wanted.every((token, at) => words[from + at]!.text.trim() === token)) continue;
      const gap = Math.abs(words[from]!.start - mark.start);
      if (gap < bestGap) {
        best = { from, to: from + wanted.length - 1 };
        bestGap = gap;
      }
    }
    if (best) return best;
  }
  const inside = words.flatMap((word, index) =>
    word.start >= mark.start - TIME_SLACK_SECONDS && word.end <= mark.end + TIME_SLACK_SECONDS
      ? [index]
      : [],
  );
  return inside.length > 0 ? { from: inside[0]!, to: inside.at(-1)! } : null;
}

// One dataset item as the eval reads it. A mark that covers no word of the
// transcript is a broken label: it throws, naming the item and the mark.
export function parseOwnerItem(json: unknown): OwnerItem {
  const parsed = itemSchema.safeParse(json);
  if (!parsed.success) {
    const id = (json as { id?: unknown } | null)?.id;
    const first = parsed.error.issues[0];
    throw new Error(
      `evals: dataset item ${String(id)} is not an owner-labelled reel: ${first?.path.join(".")} ${first?.message}`,
    );
  }
  const item = parsed.data;
  const words = item.input.transcript.words.map((word) => ({ ...word, text: word.text.trim() }));
  const span = (mark: RawMark, what: string): Span => {
    const found = spanOfMark(words, mark);
    if (!found) {
      throw new Error(
        `evals: dataset item ${item.id}: the ${what} mark "${mark.words ?? ""}" at ${mark.start}s covers no word of the transcript`,
      );
    }
    return found;
  };
  const expected = item.expected_output;
  const marks: OwnerMark[] = [];
  for (const component of ["accent", "bigword", "question"] as const) {
    for (const mark of expected[component]) marks.push({ component, span: span(mark, component) });
  }
  for (const list of expected.list) {
    const items = list.items.map((mark) => span(mark, "list item"));
    marks.push({
      component: "list",
      span: {
        from: Math.min(...items.map((one) => one.from)),
        to: Math.max(...items.map((one) => one.to)),
      },
      items,
      ...(list.level ? { level: list.level } : {}),
    });
  }
  return {
    id: item.id,
    versionId: item.version_id,
    caseKey: item.client_item_id || item.id,
    reelId: item.metadata.reel_id,
    words,
    marks,
    nothing: expected.nothing.map((mark) => span(mark, "nothing")),
  };
}

// The dataset's items as owner items, only the reel whose id starts like
// `reel` when one is given (either id may be the short form). Throws when no
// item is left.
export function selectOwnerItems(rawItems: readonly unknown[], reel?: string): OwnerItem[] {
  const items = rawItems
    .map(parseOwnerItem)
    .filter((item) => !reel || item.reelId.startsWith(reel) || reel.startsWith(item.reelId));
  if (items.length === 0) {
    throw new Error(
      reel ? `evals: no labelled reel ${reel} in the dataset` : "evals: the dataset has no item",
    );
  }
  return items;
}
