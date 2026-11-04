import { canonicalJson } from "./canonical-json.ts";
import type { BehindForbid } from "./decide.ts";
import { wordsText } from "./layout.ts";
import type { Preset } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import { resolveAnchor } from "./timeline.ts";
import type { Transcript, Word } from "./transcript.ts";

// THE VERSION DIFF. What changed between two edits, item by item, in the
// owner's terms: what kind of item, what happened to it and on which words.
// The version title and summary are written from it (`version-summary.ts`),
// so they describe the saved edit, never an intention. Pure and
// deterministic: the same edits give the same entries in the same order.

export const DIFF_KINDS = [
  "title",
  "accent",
  "photo",
  "big_word",
  "transition",
  "caption",
  "sound",
  "footage",
] as const;

export type DiffKind = (typeof DIFF_KINDS)[number];

export const DIFF_ACTIONS = ["added", "removed", "moved", "retimed", "changed"] as const;

export type DiffAction = (typeof DIFF_ACTIONS)[number];

export interface DiffEntry {
  kind: DiffKind;
  action: DiffAction;
  id: string;
  // The plain words the item is over, or its own text; never a word id.
  text?: string;
  photo_id?: string;
  // A behind photo's spot before and after, when it changed.
  spot?: { from?: string; to?: string };
}

export interface RuleChange {
  rule: "photos" | "big_word";
  to: "off" | "on";
}

export interface EditDiff {
  items: DiffEntry[];
  rules: RuleChange[];
}

type AnyItem = { id: string; start: Anchor; end: Anchor } & Record<string, unknown>;

interface Keyed {
  kind: DiffKind;
  key: string;
  item: AnyItem;
  start: number;
}

// Fields that are not placement: anchors, words, the item's own text and
// meaning, and its identity.
const NOT_PLACEMENT = new Set([
  "id",
  "kind",
  "start",
  "end",
  "words",
  "text",
  "style",
  "type",
  "sound",
  "photo_id",
  "hidden",
  "gain_db",
  "font",
  "color",
]);

// What the item is or says: its words and text, kind of transition, sound,
// look, the footage's hidden stretches.
const MEANING = [
  "words",
  "text",
  "type",
  "sound",
  "style",
  "hidden",
  "gain_db",
  "font",
  "color",
] as const;

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// The words from the start anchor's word to the end anchor's, in plain text;
// undefined when either anchor is not a word.
function spanText(
  item: AnyItem,
  transcript: Transcript,
  preset: Preset,
  order: ReadonlyMap<string, number>,
): string | undefined {
  if (!("word" in item.start) || !("word" in item.end)) return undefined;
  const from = order.get(item.start.word);
  const to = order.get(item.end.word);
  if (from === undefined || to === undefined || to < from) return undefined;
  const ids = transcript.words.slice(from, to + 1).map((word) => word.id);
  return wordsText(ids, transcript, preset);
}

function itemText(
  kind: DiffKind,
  item: AnyItem,
  transcript: Transcript,
  preset: Preset,
  order: ReadonlyMap<string, number>,
): string | undefined {
  if (kind === "big_word" && typeof item.text === "string") return item.text;
  if (typeof item.text === "string" && kind !== "title" && kind !== "accent") return item.text;
  if (Array.isArray(item.words) && item.words.length > 0) {
    return wordsText(item.words as string[], transcript, preset);
  }
  if (typeof item.text === "string") return item.text;
  if (kind === "footage" || kind === "caption") return undefined;
  return spanText(item, transcript, preset, order);
}

// Every item of an edit with its identity per kind, so the engine numbering
// items again never reads as one removed and one added.
function keyedItems(edit: Edit, words: ReadonlyMap<string, Word>): Keyed[] {
  const out: Keyed[] = [];
  const seen = new Map<string, number>();
  const push = (kind: DiffKind, base: string, item: AnyItem) => {
    const name = `${kind}:${base}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    let start = 0;
    try {
      start = resolveAnchor(item.start, words, edit.duration);
    } catch {
      start = 0;
    }
    out.push({ kind, key: count === 0 ? name : `${name}#${count}`, item, start });
  };
  const { tracks } = edit;
  for (const item of tracks.overlays as AnyItem[]) {
    if (item.id === "title") push("title", "title", item);
    else {
      const list = item.words as string[] | undefined;
      push("accent", list && list.length > 0 ? `words:${list.join(" ")}` : `id:${item.id}`, item);
    }
  }
  for (const item of (tracks.behind ?? []) as AnyItem[]) {
    if (item.kind === "photo") push("photo", String(item.photo_id), item);
    else push("big_word", String(item.text), item);
  }
  for (const item of tracks.transitions as AnyItem[]) {
    const base = "word" in item.start ? `${String(item.type)}:${item.start.word}` : `id:${item.id}`;
    push("transition", base, item);
  }
  for (const item of tracks.captions as AnyItem[]) push("caption", item.id, item);
  for (const item of tracks.sounds as AnyItem[]) push("sound", item.id, item);
  for (const item of tracks.footage as AnyItem[]) push("footage", item.id, item);
  return out;
}

function placementOf(item: AnyItem): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !NOT_PLACEMENT.has(key)));
}

interface Sortable {
  entry: DiffEntry;
  start: number;
}

// The structured difference between two edits over every track: items added,
// removed, moved (a placement field: spot, position, size), retimed (an
// anchor) and changed (text, transition type, sound, look). Captions report
// only a changed text one by one; every caption moved or retimed is one
// `captions moved` entry. Ordered by kind, then by where the item starts.
export function diffEdits(
  before: Edit,
  after: Edit,
  transcript: Transcript,
  preset: Preset,
): DiffEntry[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const order = new Map(transcript.words.map((word, index) => [word.id, index]));
  const old = keyedItems(before, words);
  const now = keyedItems(after, words);
  const oldByKey = new Map(old.map((entry) => [entry.key, entry]));
  const nowKeys = new Set(now.map((entry) => entry.key));
  const found: Sortable[] = [];
  let captionsMoved: number | null = null;
  const text = (kind: DiffKind, item: AnyItem) => itemText(kind, item, transcript, preset, order);
  const entry = (
    kind: DiffKind,
    action: DiffAction,
    item: AnyItem,
    extra: Partial<DiffEntry> = {},
  ): DiffEntry => {
    const value: DiffEntry = { kind, action, id: item.id };
    const said = text(kind, item);
    if (said !== undefined) value.text = said;
    if (typeof item.photo_id === "string") value.photo_id = item.photo_id;
    return { ...value, ...extra };
  };
  const foldCaption = (start: number) => {
    captionsMoved = captionsMoved === null ? start : Math.min(captionsMoved, start);
  };

  for (const next of now) {
    const prev = oldByKey.get(next.key);
    if (!prev) {
      if (next.kind === "caption") foldCaption(next.start);
      else found.push({ entry: entry(next.kind, "added", next.item), start: next.start });
      continue;
    }
    const a = prev.item;
    const b = next.item;
    const retimed = !same(a.start, b.start) || !same(a.end, b.end);
    const moved = !same(placementOf(a), placementOf(b));
    const changed = MEANING.some((key) => !same(a[key], b[key]));
    if (next.kind === "caption") {
      if (!same(a.text, b.text)) {
        const fixed = typeof b.text === "string" ? b.text : text("caption", b);
        const value: DiffEntry = { kind: "caption", action: "changed", id: b.id };
        if (fixed !== undefined) value.text = fixed;
        found.push({ entry: value, start: next.start });
      }
      const restChanged = MEANING.some((key) => key !== "text" && !same(a[key], b[key]));
      if (retimed || moved || restChanged) foldCaption(next.start);
      continue;
    }
    if (retimed) found.push({ entry: entry(next.kind, "retimed", b), start: next.start });
    if (moved) {
      const spot =
        a.spot !== b.spot
          ? {
              spot: {
                ...(typeof a.spot === "string" ? { from: a.spot } : {}),
                ...(typeof b.spot === "string" ? { to: b.spot } : {}),
              },
            }
          : {};
      found.push({ entry: entry(next.kind, "moved", b, spot), start: next.start });
    }
    if (changed) found.push({ entry: entry(next.kind, "changed", b), start: next.start });
  }
  for (const prev of old) {
    if (nowKeys.has(prev.key)) continue;
    if (prev.kind === "caption") foldCaption(prev.start);
    else found.push({ entry: entry(prev.kind, "removed", prev.item), start: prev.start });
  }
  if (captionsMoved !== null) {
    found.push({
      entry: { kind: "caption", action: "moved", id: "captions" },
      start: captionsMoved,
    });
  }
  const kindRank = (kind: DiffKind) => DIFF_KINDS.indexOf(kind);
  const actionRank = (action: DiffAction) => DIFF_ACTIONS.indexOf(action);
  found.sort(
    (x, y) =>
      kindRank(x.entry.kind) - kindRank(y.entry.kind) ||
      x.start - y.start ||
      (x.entry.id < y.entry.id ? -1 : x.entry.id > y.entry.id ? 1 : 0) ||
      actionRank(x.entry.action) - actionRank(y.entry.action),
  );
  return found.map(({ entry: value }) => value);
}

// The reel's behind rules an answer switched: `off` when a forbid is set,
// `on` when one is lifted.
export function ruleChanges(before: BehindForbid, after: BehindForbid): RuleChange[] {
  const out: RuleChange[] = [];
  if (before.photos !== after.photos) out.push({ rule: "photos", to: after.photos ? "off" : "on" });
  if (before.bigWord !== after.bigWord) {
    out.push({ rule: "big_word", to: after.bigWord ? "off" : "on" });
  }
  return out;
}
