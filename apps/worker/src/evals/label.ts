import type { ComponentPick, EvalWord, OwnerItem, OwnerMark, Span } from "./owner-marks.ts";

// THE CODE LABEL: every curator pick called good or bad against the owner's
// marks, by the words it covers (app_docs/evals.md, "Labels"). The judge is
// tuned until its verdicts agree with these labels.

export type Label = "good" | "bad";
// Why a pick has its label:
// - match: the owner marked the same component over these words.
// - owner: the pick is the owner's own mark.
// - wrong-component: the owner marked these words, as another component.
// - setup: the pick is inside a span the owner marked as nothing.
// - partial: the same component, but under half of the owner's mark.
// - extra: the owner marked nothing here.
export type Why = "match" | "owner" | "wrong-component" | "setup" | "partial" | "extra";

export interface Labelled {
  label: Label;
  why: Why;
}

function length(span: Span): number {
  return span.to - span.from + 1;
}

// How many words two spans share.
export function overlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from) + 1);
}

// A pick covers a mark when it holds at least half of the mark's words.
function covers(pick: Span, mark: Span): boolean {
  return overlap(pick, mark) * 2 >= length(mark);
}

function inside(pick: Span, outer: Span): boolean {
  return pick.from >= outer.from && pick.to <= outer.to;
}

// A list's items, any other mark's one span.
function partsOf(mark: ComponentPick): Span[] {
  return mark.component === "list" ? (mark.items ?? [mark.span]) : [mark.span];
}

// The words of a mark another component's pick can collide with: a list's
// items (never the gaps between them), any other mark's span. A `sections`
// list holds whole passages of the reel with other components inside them, so
// it collides with nothing.
function collisionSpans(mark: OwnerMark): Span[] {
  return mark.component === "list" && mark.level === "sections" ? [] : partsOf(mark);
}

function touches(spans: readonly Span[], others: readonly Span[]): boolean {
  return spans.some((span) => others.some((other) => overlap(span, other) > 0));
}

// A curator list against one owner list, by items. An owner item is found
// when a curator item shares a word with it: the curator names an item by its
// key words ("coffee" for the owner's "no coffee shops,"), and a `sections`
// item is a whole passage, so the half rule of a single mark does not fit an
// item. Good when at least half of the owner's items are found and at least
// half of the curator's items found one.
function listMatches(items: readonly Span[], mark: OwnerMark): boolean {
  const owner = partsOf(mark);
  const hits = (mine: Span, theirs: Span) => overlap(mine, theirs) > 0;
  const found = owner.filter((theirs) => items.some((mine) => hits(mine, theirs))).length;
  const used = items.filter((mine) => owner.some((theirs) => hits(mine, theirs))).length;
  return found > 0 && found * 2 >= owner.length && used * 2 >= items.length;
}

// One curator pick's label. The first rule that fits, in this order: match,
// setup, then for a list partial before wrong-component (its items lean on
// the owner's lists first), for any other pick wrong-component before
// partial; else extra.
export function labelPick(
  pick: ComponentPick,
  marks: readonly OwnerMark[],
  nothing: readonly Span[],
): Labelled {
  const same = marks.filter((mark) => mark.component === pick.component);
  const others = marks.filter((mark) => mark.component !== pick.component);
  const spans = partsOf(pick);
  const matched =
    pick.component === "list"
      ? same.some((mark) => listMatches(spans, mark))
      : same.some((mark) => covers(pick.span, mark.span));
  if (matched) return { label: "good", why: "match" };
  if (spans.every((span) => nothing.some((outer) => inside(span, outer)))) {
    return { label: "bad", why: "setup" };
  }
  const partial = touches(spans, same.flatMap(partsOf));
  const wrong = touches(spans, others.flatMap(collisionSpans));
  if (pick.component === "list" && partial) return { label: "bad", why: "partial" };
  if (wrong) return { label: "bad", why: "wrong-component" };
  if (partial) return { label: "bad", why: "partial" };
  return { label: "bad", why: "extra" };
}

export type Source = "curator" | "owner";

// One pick of a judge call: its name in the call (`p1`), the pick, its code
// label and where it came from (never sent to the judge).
export interface JudgePick extends ComponentPick, Labelled {
  id: string;
  sources: Source[];
}

function keyOf(pick: ComponentPick): string {
  const items = (pick.items ?? []).map((item) => `${item.from}-${item.to}`).join(",");
  return `${pick.component}:${pick.span.from}-${pick.span.to}:${items}`;
}

// FNV-1a over the seed text, then mulberry32: a small fixed generator, so the
// same run shuffles the same way every time.
function generator(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let at = 0; at < seed.length; at += 1) {
    state ^= seed.charCodeAt(at);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// The picks of one judge call: the curator run's picks with their labels and
// every owner mark as a good pick, identical picks (the same component over
// the same words and items) merged into one, then shuffled by the seed and
// named `p1`, `p2`, ... so the order says nothing about the source.
export function judgePicks(
  curator: readonly ComponentPick[],
  item: Pick<OwnerItem, "marks" | "nothing">,
  seed: string,
): JudgePick[] {
  const merged = new Map<string, Omit<JudgePick, "id">>();
  const add = (pick: ComponentPick, labelled: Labelled, source: Source) => {
    const key = keyOf(pick);
    const held = merged.get(key);
    if (!held) {
      merged.set(key, {
        component: pick.component,
        span: pick.span,
        ...(pick.items ? { items: pick.items } : {}),
        ...labelled,
        sources: [source],
      });
      return;
    }
    if (!held.sources.includes(source)) held.sources.push(source);
    // The owner's own mark is good, whatever the curator's copy was called.
    if (source === "owner") Object.assign(held, labelled);
  };
  for (const pick of curator) add(pick, labelPick(pick, item.marks, item.nothing), "curator");
  for (const mark of item.marks) add(mark, { label: "good", why: "owner" }, "owner");
  const picks = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, pick]) => pick);
  const random = generator(seed);
  for (let at = picks.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [picks[at], picks[other]] = [picks[other]!, picks[at]!];
  }
  return picks.map((pick, index) => ({ id: `p${index + 1}`, ...pick }));
}

// A pick as the judge prompt shows it (the fixed contract of `{{picks}}`).
export interface SentPick {
  pick: string;
  component: string;
  words: string;
  start: number;
  end: number;
  items?: { words: string; start: number; end: number }[];
}

export function wordsOf(words: readonly EvalWord[], span: Span): string {
  return words
    .slice(span.from, span.to + 1)
    .map((word) => word.text)
    .join(" ");
}

export function sentPick(pick: JudgePick, words: readonly EvalWord[]): SentPick {
  const shown = (span: Span) => ({
    words: wordsOf(words, span),
    start: words[span.from]!.start,
    end: words[span.to]!.end,
  });
  return {
    pick: pick.id,
    component: pick.component,
    ...shown(pick.span),
    ...(pick.items ? { items: pick.items.map(shown) } : {}),
  };
}
