import type { CheckResult } from "./checks.ts";
import type { Preset } from "./preset.ts";
import type { Edit, Item } from "./schema.ts";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TEXT_TRACKS = ["captions", "overlays", "transitions"] as const;

// A glossary term still shown as it was heard: every caption, overlay and
// transition text holding a heard variant as a whole word (any case) gives
// `<item id>: glossary: "<as written>" should be "<term>"`. Sorted, like
// runChecks.
export function glossaryCheck(edit: Edit, preset: Preset): CheckResult {
  const reasons: string[] = [];
  const patterns = preset.glossary.flatMap(({ term, heard }) =>
    heard.map((word) => ({
      term,
      // eslint-disable-next-line security/detect-non-literal-regexp -- an escaped preset word
      pattern: new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi"),
    })),
  );
  for (const track of TEXT_TRACKS) {
    const items: Item[] = edit.tracks[track];
    for (const item of items) {
      if (!("text" in item) || item.text === undefined) continue;
      for (const { term, pattern } of patterns) {
        for (const match of item.text.matchAll(pattern)) {
          reasons.push(`${item.id}: glossary: "${match[0]}" should be "${term}"`);
        }
      }
    }
  }
  reasons.sort();
  return { ok: reasons.length === 0, reasons };
}
