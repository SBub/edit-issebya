import type { Check } from "./checks.ts";
import { type Preset, cleanWord } from "./preset.ts";
import type { Edit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// The caption text the words show by default: each word cleaned, a glossary
// term when the words are one of its heard forms.
export function wordsText(ids: readonly string[], transcript: Transcript, preset: Preset): string {
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const cleaned = ids.map((id) => cleanWord(byId.get(id)?.text ?? "", preset));
  const lower = cleaned.map((text) => text.toLowerCase());
  for (const entry of preset.glossary) {
    if (entry.heard.some((form) => form.join(" ") === lower.join(" "))) return entry.term;
  }
  return cleaned.join(" ");
}

// True when `run` appears in `words` as consecutive whole words.
function containsRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || run.length > words.length) return false;
  for (let start = 0; start + run.length <= words.length; start += 1) {
    if (run.every((word, index) => words[start + index] === word)) return true;
  }
  return false;
}

// The glossary terms whose heard form a text shows (`Locking` shows the heard
// form of `lock-in`); a term written as the glossary writes it passes.
export function heardTerms(shown: string, preset: Preset): string[] {
  const words = shown
    .split(/\s+/)
    .map((word) => cleanWord(word, preset).toLowerCase())
    .filter((word) => word.length > 0);
  return preset.glossary
    .filter((entry) => entry.heard.some((form) => containsRun(words, form)))
    .map((entry) => entry.term);
}

// The glossary post-check: no caption or overlay shows a heard form of a
// glossary term (`Locking` for `lock-in`); the term itself always passes.
// The text checked is what the item shows: its `text`, else the default text
// of its words (which already writes the term).
export function glossaryChecks(edit: Edit, transcript: Transcript, preset: Preset): Check[] {
  const checks: Check[] = [];
  const items = [
    ...edit.tracks.captions.map((item) => ["caption", item] as const),
    ...edit.tracks.overlays.map((item) => ["overlay", item] as const),
  ];
  for (const [kind, item] of items) {
    const shown = item.text ?? wordsText(item.words ?? [], transcript, preset);
    for (const term of heardTerms(shown, preset)) {
      checks.push({
        rule: "glossary",
        item: item.id,
        reason: `${kind} ${item.id} shows ${JSON.stringify(shown)}: write the glossary term ${JSON.stringify(term)}`,
      });
    }
  }
  return checks;
}
