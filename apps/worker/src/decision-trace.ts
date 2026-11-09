import { type EngineNote, bigWordSpan } from "@edit-issebya/edit";

// THE DECISION TRACE: what Claude proposed for a version (its decide answer)
// beside what the layout engine did to each item (the version's engine
// record), one row per proposed item. Read-only: it explains a saved version,
// it never changes one.

// The parts of a decide answer the trace reads. Loose on purpose: an older
// version's answer may lack a list a newer prompt added. `visuals` is the
// VISUAL list of an answer.
export interface TracedAnswer {
  accents?: { from: string; to: string }[];
  // A QUESTION: a question the speaker puts to the viewer (none in an older answer).
  questions?: { from: string; to: string }[];
  // A BIGWORD: one or two words (`from` to `to`); an older answer's `word` is one word.
  big_words?: { from: string; to: string }[];
  visuals?: { from: string; to: string; description?: string }[];
  // LIST: the lists of items, each item a numbered phrase (in list order).
  lists?: { items: { from: string; to: string }[] }[];
  word_fixes?: { word: string; text: string }[];
  hook?: { text: string } | null;
}

export interface TraceRow {
  // The answer reference (`accents[0]`) and the engine's item id (`accent-1`).
  ref: string;
  item: string;
  // What Claude proposed, in words: the kind, the spoken words, its details.
  proposed: string;
  // kept: no engine note; changed: placed with notes (a pick is dropped only by
  // the same-text rule, its note says so).
  outcome: "kept" | "changed";
  // The engine's notes on it as `action (rule)`, in order.
  engine: string;
}

export interface Trace {
  rows: TraceRow[];
  // Notes on items no proposal names (captions, mostly), counted by action and rule.
  otherNotes: Record<string, number>;
}

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
// is placed under: accents `accent-N` in answer order, the rest `<kind>-N` by
// index.
function proposals(
  answer: TracedAnswer,
  say: (from: string, to: string) => string,
): { ref: string; item: string; proposed: string }[] {
  const out: { ref: string; item: string; proposed: string }[] = [];
  (answer.accents ?? []).forEach((accent, index) => {
    out.push({
      ref: `accents[${index}]`,
      item: `accent-${index + 1}`,
      proposed: `accent "${say(accent.from, accent.to)}"`,
    });
  });
  (answer.questions ?? []).forEach((question, index) => {
    out.push({
      ref: `questions[${index}]`,
      item: `question-${index + 1}`,
      proposed: `question "${say(question.from, question.to)}"`,
    });
  });
  (answer.big_words ?? []).forEach((big, index) => {
    const span = bigWordSpan(big);
    out.push({
      ref: `big_words[${index}]`,
      item: `big-word-${index + 1}`,
      proposed: `bigword "${say(span.from, span.to)}"`,
    });
  });
  (answer.visuals ?? []).forEach((visual, index) => {
    out.push({
      ref: `visuals[${index}]`,
      item: `visual-${index + 1}`,
      proposed: `visual "${visual.description ?? ""}" on "${say(visual.from, visual.to)}"`,
    });
  });
  // A LIST item's engine id counts the items of every list in reel order; its
  // proposal names its list and its place in it (`list 2.1`).
  let transition = 0;
  (answer.lists ?? []).forEach((list, listIndex) => {
    list.items.forEach((item, position) => {
      transition += 1;
      out.push({
        ref: `lists[${listIndex}].items[${position}]`,
        item: `transition-${transition}`,
        proposed: `list ${listIndex + 1}.${position + 1} "${say(item.from, item.to)}"`,
      });
    });
  });
  if (answer.hook) {
    out.push({ ref: "hook", item: "hook", proposed: `hook "${answer.hook.text}"` });
  }
  return out;
}

// Joins an answer and the engine record into rows.
export function buildTrace(
  answer: TracedAnswer,
  record: readonly EngineNote[],
  words: readonly { id: string; text: string }[],
): Trace {
  const say = (from: string, to: string) => wordsBetween(words, from, to);
  const items = proposals(answer, say);
  const named = new Set(items.map((entry) => entry.item));
  const rows = items.map(({ ref, item, proposed }): TraceRow => {
    const notes = record.filter((note) => note.item === item);
    const outcome = notes.length === 0 ? "kept" : "changed";
    return {
      ref,
      item,
      proposed,
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
  const head = ["item", "Claude proposed", "engine did", "notes"];
  const body = trace.rows.map((row) => [row.item, row.proposed, row.outcome, row.engine || "-"]);
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
    `proposed ${trace.rows.length}: kept ${count("kept")}, changed ${count("changed")}`,
    ...(fixes.length > 0 ? [`word fixes: ${fixes.join(", ")}`] : []),
    ...(others ? [`other engine notes: ${others}`] : []),
  ].join("\n");
}

// THE SCRIPT VIEW (the default): the reel as spoken, in short lines, and
// beside each line what Claude picked on it, in a few capital words, one pick
// per row. Only the picks: what the engine did is the table's job.

// The longest line before a sentence is split at a comma.
const MAX_LINE = 50;
// The widest a script line may be. A longer line splits at its speech pauses,
// else at a word boundary. The script column is this wide.
const LINE_MAX = 60;
// A gap of this many seconds or more between two words is a speech pause.
const PAUSE_SECONDS = 0.35;

// A word as spoken; the timings are optional (a transcript without them has no pauses).
type Word = { id: string; text: string; start?: number; end?: number };

// The transcript as lines of words. Sentences first (a sentence ends at . ? !).
// A line over MAX_LINE splits at the comma nearest its middle. A line over
// LINE_MAX (a stretch with no comma) splits at its largest speech pause, then,
// with no pause, after the last word that keeps it within LINE_MAX.
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
  // The silence after line[index], in seconds (0 when the timings are unknown).
  const pauseAfter = (line: Word[], index: number) => {
    const word = line[index]!;
    const next = line[index + 1];
    if (word.end === undefined || next?.start === undefined) return 0;
    return next.start - word.end;
  };
  const split = (line: Word[]): Word[][] => {
    if (length(line) <= MAX_LINE || line.length < 2) return [line];
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
    if (best >= 0) return [...split(line.slice(0, best + 1)), ...split(line.slice(best + 1))];
    if (length(line) <= LINE_MAX) return [line];
    // The longest pause decides the cut; the rest splits again the same way.
    let pause = -1;
    let longest = 0;
    for (let index = 0; index < line.length - 1; index++) {
      const gap = pauseAfter(line, index);
      if (gap >= PAUSE_SECONDS && gap > longest) [pause, longest] = [index, gap];
    }
    if (pause >= 0) return [...split(line.slice(0, pause + 1)), ...split(line.slice(pause + 1))];
    // No pause: the last word that keeps the first part within LINE_MAX.
    let cut = 0;
    for (let index = 1; index < line.length - 1; index++) {
      if (length(line.slice(0, index + 1)) > LINE_MAX) break;
      cut = index;
    }
    return [...split(line.slice(0, cut + 1)), ...split(line.slice(cut + 1))];
  };
  return sentences.flatMap(split);
}

// The header of a version's trace: both prompt versions (the hook's and the
// components'), and the decide attempts when there were more than one.
export function traceHeading(
  title: string,
  prompts: {
    hook_prompt_version: string;
    prompt_version: string;
    intensity?: string;
    target_picks?: number;
  },
  attempts: number,
): string {
  const intensity = prompts.intensity ? `, intensity ${prompts.intensity}` : "";
  const target = prompts.target_picks === undefined ? "" : `, target ${prompts.target_picks}`;
  const tried = attempts > 1 ? `, ${attempts} decide attempts` : "";
  return `${title} (prompts ${prompts.hook_prompt_version}, ${prompts.prompt_version}${intensity}${target}${tried})`;
}

// The script view as plain text. A line with several picks prints one row per
// pick; the script text is on the first.
export function formatScript(title: string, answer: TracedAnswer, words: readonly Word[]): string {
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
    add(accent.from, `ACCENT ${span(accent.from, accent.to)}`);
  }
  for (const question of answer.questions ?? []) {
    add(question.from, `QUESTION "${clean(wordsBetween(words, question.from, question.to, 40))}"`);
  }
  for (const big of answer.big_words ?? []) {
    const span = bigWordSpan(big);
    add(span.from, `BIGWORD "${clean(wordsBetween(words, span.from, span.to))}"`);
  }
  // A VISUAL is its description on its words (the words only when the span is
  // not the whole line); the description is never shown on screen.
  for (const visual of answer.visuals ?? []) {
    const where = span(visual.from, visual.to);
    const on = where === "whole line" ? "" : ` on ${where}`;
    add(visual.from, `VISUAL "${visual.description ?? ""}"${on}`);
  }
  // LIST items on single words of the same line and list read as one pick:
  // LIST 1 "Relationship" "taste" (the number is the list's).
  const grouped = new Map<string, string[]>();
  (answer.lists ?? []).forEach((list, listIndex) => {
    for (const item of list.items) {
      if (item.from === item.to) {
        const key = `${listIndex}:${lineOf.get(item.from) ?? 0}`;
        grouped.set(key, [
          ...(grouped.get(key) ?? []),
          `"${clean(wordsBetween(words, item.from, item.to))}"`,
        ]);
      } else {
        add(item.from, `LIST ${listIndex + 1} ${span(item.from, item.to)}`);
      }
    }
  });
  for (const [key, names] of grouped) {
    const [list, line] = key.split(":").map(Number);
    picks[line!]!.push(`LIST ${list! + 1} ${names.join(" ")}`);
  }
  const texts = lines.map((line) => line.map((word) => word.text.trim()).join(" "));
  const fixes = (answer.word_fixes ?? []).map((fix) => {
    const said = words.find((word) => word.id === fix.word)?.text.trim() ?? fix.word;
    return `"${said}" -> "${fix.text}"`;
  });
  const rows = texts.flatMap((text, index) => {
    const list = picks[index]!.length > 0 ? picks[index]! : [""];
    return list.map((pick, row) =>
      `${(row === 0 ? text : "").padEnd(LINE_MAX)}  │ ${pick}`.trimEnd(),
    );
  });
  return [
    title,
    `HOOK  ${answer.hook ? `"${answer.hook.text}"` : "none"}`,
    "",
    ...rows,
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
