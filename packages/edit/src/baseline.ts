import { type Preset, cleanWord } from "./preset.ts";
import type { CaptionItem, Edit, EditInputs } from "./schema.ts";
import type { Transcript, Word } from "./transcript.ts";

// A spoken number: digits, maybe with a decimal point or thousands commas.
const NUMBER = /^\d[\d.,]*$/;

// The words of the transcript as caption units: a glossary term from any of
// its heard forms, a number with the unit after it, a month with its day
// number (either order); every other word alone.
function units(words: readonly Word[], preset: Preset): Word[][] {
  const cleaned = words.map((word) => cleanWord(word.text, preset).toLowerCase());
  const out: Word[][] = [];
  let index = 0;
  while (index < words.length) {
    const rest = cleaned.slice(index);
    const term = preset.glossary
      .flatMap((entry) => entry.heard)
      .filter((form) => form.every((part, at) => rest[at] === part))
      .sort((a, b) => b.length - a.length)[0];
    let size = term ? term.length : 1;
    const here = cleaned[index]!;
    const next = cleaned[index + 1];
    if (!term && next !== undefined) {
      if (NUMBER.test(here) && preset.units.includes(next)) size = 2;
      else if (preset.months.includes(here) && NUMBER.test(next)) size = 2;
      else if (NUMBER.test(here) && preset.months.includes(next)) size = 2;
    }
    out.push(words.slice(index, index + size));
    index += size;
  }
  return out;
}

// Units grouped into the sets shown together: a new group at a pause of the
// preset's length or after its maximum number of units.
function groups(list: Word[][], preset: Preset): Word[][][] {
  const out: Word[][][] = [];
  for (const unit of list) {
    const last = out.at(-1);
    const previous = last?.at(-1)?.at(-1);
    const pause = previous ? unit[0]!.start - previous.end : 0;
    if (
      !last ||
      last.length >= preset.caption.groupMaxUnits ||
      pause >= preset.caption.groupPauseSeconds
    ) {
      out.push([unit]);
    } else {
      last.push(unit);
    }
  }
  return out;
}

// The automatic first version, from the preset alone (no AI): the footage
// and the cut-out over the whole reel, one caption per word or unit, starting
// on its own word and ending on the last word of its group. No positions
// (the builder fills them), no accents, transitions or sounds.
export function baselineEdit(
  transcript: Transcript,
  { inputs, duration }: { inputs: EditInputs; duration: number },
  preset: Preset,
): Edit {
  const captions: CaptionItem[] = [];
  for (const group of groups(units(transcript.words, preset), preset)) {
    const last = group.at(-1)!.at(-1)!;
    for (const unit of group) {
      captions.push({
        id: `c${unit[0]!.id.toLowerCase()}`,
        start: { word: unit[0]!.id },
        end: { word: last.id, edge: "end" },
        words: unit.map((word) => word.id),
      });
    }
  }
  const whole = { start: { reel: "start" as const }, end: { reel: "end" as const } };
  return {
    format: 1,
    preset: preset.id,
    duration: Math.round(duration * 1000) / 1000,
    inputs,
    tracks: {
      footage: [{ id: "footage", ...whole }],
      cutout: [{ id: "cutout", ...whole }],
      captions,
      overlays: [],
      transitions: [],
      sounds: [],
    },
  };
}
