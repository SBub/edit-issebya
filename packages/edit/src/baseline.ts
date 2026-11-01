import type { Preset } from "./preset.ts";
import type { Edit } from "./schema.ts";
import type { Transcript, Word } from "./transcript.ts";

const EDGE_PUNCTUATION = /^[\s,.?!;:"]+|[\s,.?!;:"]+$/g;

// A word as a caption shows it: edge punctuation gone, lower case unless the
// preset keeps its capitals, and a glossary term for a word heard as another.
export function captionText(word: Word, preset: Preset): string {
  const plain = word.text.replace(EDGE_PUNCTUATION, "").toLowerCase();
  const term = preset.glossary.find((entry) => entry.heard.includes(plain));
  if (term) return term.term;
  return preset.keepCaps[plain] ?? plain;
}

// The automatic first version, from the preset alone: footage and cut-out
// from the start to the end of the last word, one caption per word anchored
// to itself, nothing else. The decide step builds on it.
export function baselineEdit(transcript: Transcript, inputs: Edit["inputs"], preset: Preset): Edit {
  const last = transcript.words.at(-1);
  if (!last) throw new Error("baseline: the transcript has no words");
  const whole = { start: { at: 0 }, end: { word: last.id, edge: "end" as const } };
  const captions: Edit["tracks"]["captions"] = [];
  for (const word of transcript.words) {
    const text = captionText(word, preset);
    if (text === "") continue;
    captions.push({
      id: `c-${word.id}`,
      start: { word: word.id },
      // A word with no length stays the minimum time on screen.
      end:
        word.end > word.start
          ? { word: word.id }
          : { word: word.id, edge: "end", offset: preset.caption.minOnScreen },
      text,
      words: [word.id],
    });
  }
  return {
    format: 1,
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
