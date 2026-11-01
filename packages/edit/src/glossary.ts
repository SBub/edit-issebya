import type { Check } from "./checks.ts";
import { wordsText } from "./layout.ts";
import { type Preset, cleanWord } from "./preset.ts";
import type { Edit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// True when `run` appears in `words` as consecutive whole words.
function containsRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || run.length > words.length) return false;
  for (let start = 0; start + run.length <= words.length; start += 1) {
    if (run.every((word, index) => words[start + index] === word)) return true;
  }
  return false;
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
    const words = shown
      .split(/\s+/)
      .map((word) => cleanWord(word, preset).toLowerCase())
      .filter((word) => word.length > 0);
    for (const entry of preset.glossary) {
      const heard = entry.heard.find((form) => containsRun(words, form));
      if (!heard) continue;
      checks.push({
        rule: "glossary",
        item: item.id,
        reason: `${kind} ${item.id} shows ${JSON.stringify(shown)}: write the glossary term ${JSON.stringify(entry.term)}`,
      });
    }
  }
  return checks;
}
