import { z } from "zod";
import type { Preset } from "./preset.ts";
import { issueReasons } from "./schema.ts";
import { DIFF_KINDS, type DiffEntry, type DiffKind, type EditDiff } from "./version-diff.ts";

// THE VERSION TITLE AND SUMMARY, written after layout from the saved
// difference (`version-diff.ts`): the answer a short second AI call gives,
// the safeguard its text must pass, and the code template that replaces it
// when it does not. All pure.

const MAX_TITLE = 60;
const MAX_SUMMARY = 300;

export const summaryAnswerSchema = z.strictObject({
  change_title: z.string().min(1).max(MAX_TITLE),
  change_summary: z.string().min(1).max(MAX_SUMMARY),
});

export type SummaryAnswer = z.infer<typeof summaryAnswerSchema>;

// The summary answer's JSON Schema for the AI's structured output: the same draft-07
// settings as the decide answer's.
export function summaryJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(summaryAnswerSchema, {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

export function parseSummaryAnswer(
  json: unknown,
): { ok: true; answer: SummaryAnswer } | { ok: false; reasons: string[] } {
  const result = summaryAnswerSchema.safeParse(json);
  if (result.success) return { ok: true, answer: result.data };
  return { ok: false, reasons: issueReasons(json, result.error.issues) };
}

// The words that name each kind of item, matched as whole words, any case.
const NAMES: Record<DiffKind, readonly string[]> = {
  title: ["title", "titles", "heading", "opening line"],
  hook: ["hook", "hooks"],
  accent: ["accent", "accents", "highlight", "highlights", "highlighted", "stands out", "emphasis"],
  photo: ["photo", "photos", "picture", "pictures", "image", "images"],
  visual: ["visual", "visuals"],
  big_word: ["big word", "key word"],
  transition: ["transition", "transitions", "fade", "fades", "dim", "cut", "cuts"],
  caption: ["caption", "captions", "spelling", "word fixed", "words fixed", "misheard"],
  sound: ["sound", "sounds", "whoosh"],
  footage: ["footage", "clip", "clips", "trimmed"],
};

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWords(phrase: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from the fixed lists above and the preset's font names, escaped
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escape(phrase).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`,
    "iu",
  );
}

const NAME_PATTERNS = Object.fromEntries(
  DIFF_KINDS.map((kind) => [kind, NAMES[kind].map(wholeWords)]),
) as unknown as Record<DiffKind, RegExp[]>;

// What a title or summary never carries.
const FORBIDDEN: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\bw\d+\b/i, reason: "carries a word id" },
  {
    pattern: /\d\s*(?:s|secs?|seconds?|px|pt|%)(?![\p{L}\p{N}])/iu,
    reason: "carries a time or a size",
  },
  { pattern: /\d+:\d{2}/, reason: "carries a time" },
  { pattern: /#[0-9a-f]{3,8}\b/i, reason: "carries a colour code" },
  {
    pattern: /\b(?:tracks?|slots?|presets?|overlays?|spots?)\b/i,
    reason: "carries an internal name",
  },
];

function namedKinds(text: string): DiffKind[] {
  return DIFF_KINDS.filter((kind) => NAME_PATTERNS[kind].some((pattern) => pattern.test(text)));
}

function inDiff(kind: DiffKind, diff: EditDiff): boolean {
  if (diff.items.some((entry) => entry.kind === kind)) return true;
  if (isPicture(kind)) return diff.rules.some((change) => change.rule === "photos");
  if (kind === "big_word") return diff.rules.some((change) => change.rule === "big_word");
  return false;
}

function fontNames(preset: Preset): string[] {
  const names = new Set<string>();
  for (const font of Object.values(preset.fonts)) {
    names.add(font.family);
    const first = font.family.split(/\s+/)[0];
    if (first && first.length > 3) names.add(first);
  }
  return [...names];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const label = (kind: DiffKind) => kind.replace("_", " ");

// The safeguard: the text carries no word id, time, size, colour code, font
// or internal name, and every kind of item it names is in the saved
// difference (photos and the big word also when their rule switched).
export function checkSummary(
  answer: SummaryAnswer,
  diff: EditDiff,
  preset: Preset,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const both = `${answer.change_title}\n${answer.change_summary}`;
  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(both)) reasons.push(reason);
  }
  if (fontNames(preset).some((name) => wholeWords(name).test(both))) {
    reasons.push("carries a font name");
  }
  const missing = new Set<DiffKind>();
  for (const kind of namedKinds(answer.change_title)) {
    if (!inDiff(kind, diff)) missing.add(kind);
  }
  for (const sentence of sentences(answer.change_summary)) {
    for (const kind of namedKinds(sentence)) {
      if (!inDiff(kind, diff)) missing.add(kind);
    }
  }
  for (const kind of DIFF_KINDS) {
    if (missing.has(kind)) {
      reasons.push(`names a ${label(kind)} that is not in the saved difference`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

const NUMBERS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];

function counted(count: number): string {
  return NUMBERS[count] ?? "Many";
}

// A picture behind the speaker: a library photo (an older version's) or a
// VISUAL frame. Both follow the photos switch and read as pictures.
function isPicture(kind: DiffKind): boolean {
  return kind === "photo" || kind === "visual";
}

const NOUN: Record<DiffKind, { one: string; many: string }> = {
  title: { one: "title", many: "titles" },
  hook: { one: "hook", many: "hooks" },
  accent: { one: "accent", many: "accents" },
  photo: { one: "photo", many: "photos" },
  visual: { one: "visual", many: "visuals" },
  big_word: { one: "big word", many: "big words" },
  transition: { one: "transition", many: "transitions" },
  caption: { one: "caption", many: "captions" },
  sound: { one: "sound", many: "sounds" },
  footage: { one: "footage", many: "footage" },
};

const VERB: Record<DiffEntry["action"], string> = {
  added: "added",
  removed: "removed",
  moved: "moved",
  retimed: "timing changed",
  changed: "changed",
};

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A kind in a two-kind title: `Title and captions changed`.
function pairNoun(kind: DiffKind): string {
  return kind === "caption" ? "captions" : NOUN[kind].one;
}

const EMPTY_DIFF: EditDiff = { items: [], rules: [] };

interface Group {
  kind: DiffKind;
  entries: DiffEntry[];
  rule: "off" | "on" | null;
}

function groupsOf(diff: EditDiff): Group[] {
  return DIFF_KINDS.flatMap((kind): Group[] => {
    const entries = diff.items.filter((entry) => entry.kind === kind);
    const ruleName = isPicture(kind) ? "photos" : kind === "big_word" ? "big_word" : null;
    // The photos switch names the pictures once: a visual never has a group of
    // its own for it.
    const rule =
      kind === "visual"
        ? null
        : (diff.rules.find((change) => change.rule === ruleName)?.to ?? null);
    return entries.length > 0 || rule !== null ? [{ kind, entries, rule }] : [];
  });
}

// The one action all entries share, else null.
function sharedAction(entries: readonly DiffEntry[]): DiffEntry["action"] | null {
  const first = entries[0]?.action ?? null;
  return entries.every((entry) => entry.action === first) ? first : null;
}

function titleOf(group: Group): string {
  const { kind, entries, rule } = group;
  if (entries.length === 0 && rule !== null) {
    return `${capital(isPicture(kind) ? "photos" : "big word")} switched ${rule}`;
  }
  if (kind === "caption") {
    const fixed = entries.filter((entry) => entry.action === "changed").length;
    if (fixed === 0) return "Captions adjusted";
    return fixed === 1 ? "Word fixed" : "Words fixed";
  }
  const action = sharedAction(entries);
  const noun = entries.length === 1 || kind === "title" ? NOUN[kind].one : NOUN[kind].many;
  return `${capital(noun)} ${action ? VERB[action] : "changed"}`;
}

// A short quote of the words (a hook's whole line), only when it names
// nothing and carries nothing the safeguard refuses.
function quoteOf(text: string | undefined, preset: Preset, longest = 30): string | null {
  if (text === undefined) return null;
  const clean = text.replace(/["“”]/g, "").trim();
  if (clean.length === 0 || clean.length > longest) return null;
  const probe = { change_title: "x", change_summary: clean };
  return checkSummary(probe, EMPTY_DIFF, preset).ok ? `"${clean}"` : null;
}

function sentenceOf(group: Group, preset: Preset, quotes: boolean): string {
  const { kind, entries, rule } = group;
  const ruleSentence =
    rule === null
      ? null
      : isPicture(kind)
        ? rule === "off"
          ? "Photos are switched off for this reel."
          : "Photos are allowed again for this reel."
        : rule === "off"
          ? "Big words are switched off for this reel."
          : "Big words are allowed again for this reel.";
  if (entries.length === 0) return ruleSentence ?? "";
  const first = entries[0]!;
  const quote = quotes ? quoteOf(first.text, preset) : null;
  let sentence: string;
  if (kind === "hook") {
    // One hook per reel: what it says now, quoted whole when it quotes safely.
    const line = quotes ? quoteOf(first.text, preset, preset.pace.hook.maxCharacters) : null;
    sentence =
      first.action === "added"
        ? line
          ? `A hook now opens the reel: ${line}.`
          : "A hook now opens the reel."
        : first.action === "removed"
          ? "The hook at the start was taken out."
          : first.action === "changed"
            ? line
              ? `The hook now reads ${line}.`
              : "The hook now reads differently."
            : first.action === "moved"
              ? "The hook moved to another place."
              : "The hook now shows at a different moment.";
  } else if (kind === "caption") {
    const fixed = entries.filter((entry) => entry.action === "changed");
    if (fixed.length === 0) sentence = "The captions moved to make room.";
    else {
      const fixQuote = quotes ? quoteOf(fixed[0]!.text, preset) : null;
      sentence =
        fixed.length === 1
          ? `One word in the captions is fixed${fixQuote ? `, it now reads ${fixQuote}` : ""}.`
          : `${counted(fixed.length)} words in the captions are fixed.`;
    }
  } else {
    const action = sharedAction(entries);
    const { one, many } = NOUN[kind];
    // Behind the speaker, or in front of them when every photo is.
    const where =
      isPicture(kind) && entries.every((entry) => entry.front)
        ? " in front of you"
        : isPicture(kind) && entries.some((entry) => entry.front)
          ? ""
          : isPicture(kind) || kind === "big_word"
            ? " behind you"
            : "";
    const on = quote ? (isPicture(kind) ? ` while you say ${quote}` : ` on ${quote}`) : "";
    if (entries.length > 1 && action !== null && kind !== "footage") {
      const what = `${counted(entries.length)} ${many}`;
      const moods = entries.filter((entry) => entry.reason === "mood").length;
      const mood =
        isPicture(kind) && moods > 0
          ? ` ${moods === entries.length ? "All" : counted(moods)} of them ${moods === 1 ? "is" : "are"} there for the mood and ${moods === 1 ? "does" : "do"} not show what you say.`
          : "";
      sentence = {
        added: `${what} were added${where}.${mood}`,
        removed: `${what} were taken out.`,
        moved: `${what} moved to another place.`,
        retimed: `${what} now show at a different moment.`,
        changed: `${what} changed.`,
      }[action];
    } else if (entries.length > 1) {
      sentence = `The ${many} changed.`;
    } else {
      const article = kind === "footage" ? "The" : /^[aeiou]/.test(one) ? "An" : "A";
      sentence = {
        // A mood photo is said to be one: it does not show what is said.
        added:
          isPicture(kind) && first.reason === "mood"
            ? `${article} ${one} now shows${where}${on} for the mood: it does not show what you say.`
            : isPicture(kind) || kind === "big_word"
              ? `${article} ${one} now shows${where}${on}.`
              : `${article} ${one} was added${on}.`,
        removed: `The ${one}${on} was taken out.`,
        moved: `The ${one}${where} moved to another place.`,
        retimed:
          kind === "transition" && first.was !== undefined
            ? transitionCovers(first, preset, quotes)
            : `The ${one}${on} now shows at a different moment.`,
        changed:
          kind === "footage"
            ? "The footage was trimmed differently."
            : kind === "transition" && first.change
              ? `The ${one}${on} ${TRANSITION_CHANGE[first.change]}.`
              : `The ${one}${on} changed.`,
      }[first.action];
    }
  }
  return ruleSentence ? `${sentence} ${ruleSentence}` : sentence;
}

// A transition's motion or hold change, as the summary says it.
const TRANSITION_CHANGE: Record<NonNullable<DiffEntry["change"]>, string> = {
  slower: "moves slower",
  "usual speed": "moves at its usual speed again",
  "stays longer": "stays longer",
  "usual hold": "leaves sooner again",
};

// A transition now over other words: the words it was on and the words it
// covers now, when both quote safely.
function transitionCovers(entry: DiffEntry, preset: Preset, quotes: boolean): string {
  const was = quotes ? quoteOf(entry.was, preset) : null;
  const now = quotes ? quoteOf(entry.text, preset) : null;
  if (was && now) return `The transition on ${was} now covers ${now}.`;
  if (now) return `The transition now covers ${now}.`;
  return "The transition now covers other words.";
}

function joinSummary(parts: readonly string[], more: boolean): string {
  if (!more) return parts.join(" ");
  const last = parts.at(-1)!.replace(/\.$/, "");
  return [...parts.slice(0, -1), `${last}, and a few smaller changes.`].join(" ");
}

// The code template: a title and summary written from the difference. Its
// own output always passes `checkSummary` and the schema's lengths.
export function summaryTemplate(
  diff: EditDiff,
  preset: Preset,
): { title: string; summary: string } {
  const groups = groupsOf(diff);
  const title =
    groups.length === 0
      ? "No changes"
      : groups.length === 1
        ? titleOf(groups[0]!)
        : groups.length === 2
          ? `${capital(pairNoun(groups[0]!.kind))} and ${pairNoun(groups[1]!.kind)} changed`
          : "Several things changed";
  const candidates = [true, false].map((quotes) => {
    const parts =
      groups.length === 0
        ? ["Nothing in the reel changed."]
        : groups.slice(0, 2).map((group) => sentenceOf(group, preset, quotes));
    return joinSummary(parts, groups.length > 2);
  });
  const summary =
    candidates.find((text) => text.length <= MAX_SUMMARY) ??
    candidates.at(-1)!.slice(0, MAX_SUMMARY);
  return { title, summary };
}
