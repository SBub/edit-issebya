import type { EngineNote } from "@edit-issebya/edit";

// THE DECISION TRACE: what Claude proposed for a version (its final decide
// answer and the editorial rounds) beside what the layout engine did to each
// item (the version's engine record), one row per proposed item. Read-only:
// it explains a saved version, it never changes one.

// The parts of a decide answer the trace reads. Loose on purpose: an older
// version's answer may lack a list a newer prompt added. `photos` is an older
// answer's library photos (kept so those versions still trace); `visuals` is
// the VISUAL list of a new answer.
export interface TracedAnswer {
  accents?: { from: string; to: string; title?: boolean; wish?: string }[];
  big_words?: { word: string; wish?: string }[];
  visuals?: { from: string; to: string; description?: string }[];
  photos?: { photo_id: string; from: string; to: string; reason?: string; wish?: string }[];
  transitions?: { kind: string; from: string; to: string; wish?: string }[];
  word_fixes?: { word: string; text: string }[];
  hook?: { text: string } | null;
}

// One editorial choice: the item moved to other words (an older answer's
// photo may also name another photo), or skipped.
export interface TracedEditorialChoice {
  item: string;
  skip: boolean;
  from?: string;
  to?: string;
  photo_id?: string;
  why?: string;
}

export interface TraceRow {
  // The answer reference (`accents[0]`) and the engine's item id (`accent-1`).
  ref: string;
  item: string;
  // What Claude proposed, in words: the kind, the spoken words, its details.
  proposed: string;
  // What the editorial rounds did to it, if anything.
  editorial: string;
  // kept: no engine note; changed: placed with notes; dropped: left out.
  outcome: "kept" | "changed" | "dropped";
  // The engine's notes on it as `action (rule)`, in order.
  engine: string;
}

export interface Trace {
  rows: TraceRow[];
  // Notes on items no proposal names (captions, mostly), counted by action and rule.
  otherNotes: Record<string, number>;
}

const DROPPING = new Set(["dropped", "removed"]);

// The words from one id to another, as spoken, shortened past `max` characters.
export function wordsBetween(
  words: readonly { id: string; text: string }[],
  from: string,
  to: string,
  max = 48,
): string {
  const start = words.findIndex((word) => word.id === from);
  const end = words.findIndex((word) => word.id === to);
  if (start < 0 || end < 0) return `${from}..${to}`;
  const text = words
    .slice(start, end + 1)
    .map((word) => word.text.trim())
    .join(" ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The answer's items in order, each with its reference and the engine id it
// is placed under: the title accent is `title`, other accents `accent-N` in
// answer order, the rest `<kind>-N` by index.
function proposals(
  answer: TracedAnswer,
  say: (from: string, to: string) => string,
): { ref: string; item: string; proposed: string }[] {
  const out: { ref: string; item: string; proposed: string }[] = [];
  const wish = (value?: string) => (value ? `, wish ${value}` : "");
  let accentCount = 0;
  (answer.accents ?? []).forEach((accent, index) => {
    out.push({
      ref: `accents[${index}]`,
      item: accent.title ? "title" : `accent-${++accentCount}`,
      proposed: `${accent.title ? "hook" : "accent"} "${say(accent.from, accent.to)}"${wish(accent.wish)}`,
    });
  });
  (answer.big_words ?? []).forEach((big, index) => {
    out.push({
      ref: `big_words[${index}]`,
      item: `big-word-${index + 1}`,
      proposed: `bigword "${say(big.word, big.word)}"${wish(big.wish)}`,
    });
  });
  (answer.visuals ?? []).forEach((visual, index) => {
    out.push({
      ref: `visuals[${index}]`,
      item: `visual-${index + 1}`,
      proposed: `visual "${visual.description ?? ""}" on "${say(visual.from, visual.to)}"`,
    });
  });
  // An older answer's library photos (their engine ids stay `photo-N`).
  (answer.photos ?? []).forEach((photo, index) => {
    out.push({
      ref: `photos[${index}]`,
      item: `photo-${index + 1}`,
      proposed: `image ${photo.photo_id.slice(0, 8)} (${photo.reason ?? "?"}) on "${say(photo.from, photo.to)}"${wish(photo.wish)}`,
    });
  });
  (answer.transitions ?? []).forEach((transition, index) => {
    // A numbered transition is a list; any other kind is an accent (dim, panel).
    const said = say(transition.from, transition.to);
    const proposed =
      transition.kind === "numbered" ? `list "${said}"` : `accent "${said}" (${transition.kind})`;
    out.push({
      ref: `transitions[${index}]`,
      item: `transition-${index + 1}`,
      proposed: `${proposed}${wish(transition.wish)}`,
    });
  });
  if (answer.hook) {
    out.push({ ref: "hook", item: "hook", proposed: `hook "${answer.hook.text}"` });
  }
  return out;
}

// Joins an answer, its editorial rounds and the engine record into rows.
export function buildTrace(
  answer: TracedAnswer,
  editorialRounds: readonly (readonly TracedEditorialChoice[])[],
  record: readonly EngineNote[],
  words: readonly { id: string; text: string }[],
): Trace {
  const say = (from: string, to: string) => wordsBetween(words, from, to);
  const items = proposals(answer, say);
  const named = new Set(items.map((entry) => entry.item));
  const rows = items.map(({ ref, item, proposed }): TraceRow => {
    const notes = record.filter((note) => note.item === item);
    const editorial = editorialRounds
      .map((round, index) => {
        const choice = round.find((entry) => entry.item === ref);
        if (!choice) return null;
        if (choice.skip) return `r${index + 1} skipped: ${choice.why ?? ""}`.trim();
        const photo = choice.photo_id ? ` photo ${choice.photo_id.slice(0, 8)}` : "";
        return `r${index + 1} moved to "${say(choice.from ?? "", choice.to ?? "")}"${photo}`;
      })
      .filter((entry): entry is string => entry !== null)
      .join("; ");
    // The last word is the engine's: a drop then a placement in a later
    // round reads as changed.
    const last = notes.at(-1);
    const outcome =
      notes.length === 0 ? "kept" : last && DROPPING.has(last.action) ? "dropped" : "changed";
    return {
      ref,
      item,
      proposed,
      editorial,
      outcome,
      engine: notes.map((note) => `${note.action} (${note.rule})`).join(", "),
    };
  });
  const otherNotes: Record<string, number> = {};
  for (const note of record) {
    if (named.has(note.item)) continue;
    const key = `${note.action} (${note.rule})`;
    otherNotes[key] = (otherNotes[key] ?? 0) + 1;
  }
  return { rows, otherNotes };
}

// The trace as plain text: a header, one aligned row per item, the counts.
export function formatTrace(title: string, trace: Trace, fixes: string[] = []): string {
  const head = ["item", "Claude proposed", "engine did", "notes", "editorial"];
  const body = trace.rows.map((row) => [
    row.item,
    row.proposed,
    row.outcome,
    row.engine || "-",
    row.editorial || "-",
  ]);
  const widths = head.map((label, column) =>
    Math.min(70, Math.max(label.length, ...body.map((cells) => cells[column]!.length))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  const count = (outcome: TraceRow["outcome"]) =>
    trace.rows.filter((row) => row.outcome === outcome).length;
  const others = Object.entries(trace.otherNotes)
    .map(([key, n]) => `${n}x ${key}`)
    .join(", ");
  return [
    title,
    line(head),
    ...body.map(line),
    `proposed ${trace.rows.length}: kept ${count("kept")}, changed ${count("changed")}, dropped ${count("dropped")}`,
    ...(fixes.length > 0 ? [`word fixes: ${fixes.join(", ")}`] : []),
    ...(others ? [`other engine notes: ${others}`] : []),
  ].join("\n");
}

// THE SCRIPT VIEW (the default): the reel as spoken, one line per sentence
// (a long sentence split at its middle comma), and beside each line what
// Claude picked on it, in a few capital words. Only the picks: what the
// engine did is the table's job.

// The longest line before a sentence is split at a comma.
const MAX_LINE = 50;

type Word = { id: string; text: string };

// The transcript as lines of words: sentences, long ones split at the comma
// nearest their middle until every part fits or has no comma.
export function scriptLines(words: readonly Word[]): Word[][] {
  const sentences: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    current.push(word);
    if (/[.!?]["')\]]?$/.test(word.text.trim())) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length > 0) sentences.push(current);
  const length = (line: Word[]) => line.map((word) => word.text.trim()).join(" ").length;
  const split = (line: Word[]): Word[][] => {
    if (length(line) <= MAX_LINE) return [line];
    const middle = length(line) / 2;
    let best = -1;
    let bestDistance = Infinity;
    let at = 0;
    line.forEach((word, index) => {
      at += word.text.trim().length + 1;
      if (index < line.length - 1 && /,$/.test(word.text.trim())) {
        const distance = Math.abs(at - middle);
        if (distance < bestDistance) [best, bestDistance] = [index, distance];
      }
    });
    if (best < 0) return [line];
    return [...split(line.slice(0, best + 1)), ...split(line.slice(best + 1))];
  };
  return sentences.flatMap(split);
}

// A transition kind as the owner reads it: numbered is a LIST. Every other
// kind (dim, panel, ...) is an ACCENT with its kind in brackets.
const TRANSITION_LABEL: Record<string, string> = { numbered: "LIST" };

// The script view as plain text. `photoNames` names an older answer's library
// photo by id (its first tag or a short description); an unnamed photo shows its id.
export function formatScript(
  title: string,
  answer: TracedAnswer,
  words: readonly Word[],
  photoNames: ReadonlyMap<string, string> = new Map(),
): string {
  const lines = scriptLines(words);
  const lineOf = new Map<string, number>();
  lines.forEach((line, index) => line.forEach((word) => lineOf.set(word.id, index)));
  const picks: string[][] = lines.map(() => []);
  const clean = (text: string) => text.replace(/[.,!?;:]+$/, "");
  // The picked words: "whole line" when they are exactly their line.
  const span = (from: string, to: string) => {
    const line = lines[lineOf.get(from) ?? -1];
    if (line && line[0]!.id === from && line.at(-1)!.id === to) return "whole line";
    return `"${clean(wordsBetween(words, from, to, 40))}"`;
  };
  const add = (from: string, pick: string) => picks[lineOf.get(from) ?? 0]?.push(pick);
  for (const accent of answer.accents ?? []) {
    add(accent.from, `${accent.title ? "HOOK" : "ACCENT"} ${span(accent.from, accent.to)}`);
  }
  for (const big of answer.big_words ?? []) {
    add(big.word, `BIGWORD "${clean(wordsBetween(words, big.word, big.word))}"`);
  }
  // A VISUAL is its description on its words (the words only when the span is
  // not the whole line); the description is never shown on screen.
  for (const visual of answer.visuals ?? []) {
    const where = span(visual.from, visual.to);
    const on = where === "whole line" ? "" : ` on ${where}`;
    add(visual.from, `VISUAL "${visual.description ?? ""}"${on}`);
  }
  // An older answer's library photo, shown as the VISUAL it was.
  for (const photo of answer.photos ?? []) {
    const name = photoNames.get(photo.photo_id) ?? photo.photo_id.slice(0, 8);
    add(photo.from, `VISUAL photo ${name}`);
  }
  // LIST transitions on single words of the same line read as one pick:
  // LIST "Relationship" "taste".
  const grouped = new Map<string, string[]>();
  for (const transition of answer.transitions ?? []) {
    const label = TRANSITION_LABEL[transition.kind];
    if (label && transition.from === transition.to) {
      const key = `${lineOf.get(transition.from) ?? 0}|${label}`;
      grouped.set(key, [
        ...(grouped.get(key) ?? []),
        `"${clean(wordsBetween(words, transition.from, transition.to))}"`,
      ]);
    } else if (label) {
      add(transition.from, `${label} ${span(transition.from, transition.to)}`);
    } else {
      add(transition.from, `ACCENT ${span(transition.from, transition.to)} (${transition.kind})`);
    }
  }
  for (const [key, names] of grouped) {
    const [line, label] = key.split("|");
    picks[Number(line)]!.push(`${label} ${names.join(" ")}`);
  }
  const texts = lines.map((line) => line.map((word) => word.text.trim()).join(" "));
  const width = Math.max(0, ...texts.map((text) => text.length));
  const fixes = (answer.word_fixes ?? []).map((fix) => {
    const said = words.find((word) => word.id === fix.word)?.text.trim() ?? fix.word;
    return `"${said}" -> "${fix.text}"`;
  });
  return [
    title,
    `HOOK  ${answer.hook ? `"${answer.hook.text}"` : "none"}`,
    "",
    ...texts.map((text, index) =>
      `${text.padEnd(width)}  │ ${picks[index]!.join(" · ")}`.trimEnd(),
    ),
    ...(fixes.length > 0 ? ["", `FIXES ${fixes.join(", ")}`] : []),
  ].join("\n");
}

// A model's answer text as JSON: plain, or inside a ```json fence.
export function answerJson(text: string | null): unknown {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1]! : text) as unknown;
  } catch {
    return null;
  }
}

// The hook a version shows: the text of its last readable `hook` call (the
// hook has its own call now, `hook.md`), else the decide answer's `hook` (an
// older record's answer carries it).
export function hookOf(
  calls: readonly { role: string; answerText: string | null }[],
  answer: TracedAnswer,
): { text: string } | null {
  const texts = calls
    .filter((call) => call.role === "hook")
    .map((call) => answerJson(call.answerText))
    .flatMap((json) => {
      const text = (json as { text?: unknown } | null)?.text;
      return typeof text === "string" ? [text] : [];
    });
  const last = texts.at(-1);
  if (last !== undefined) return { text: last };
  return answer.hook ?? null;
}
