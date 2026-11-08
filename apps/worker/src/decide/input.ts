import {
  type Intensity,
  type Preset,
  type Transcript,
  sentenceSpans,
  wordsText,
} from "@edit-issebya/edit";

// One spoken sentence as the components prompt sees it: its text, and its
// words with the ids the answer names them by (no times, no positions).
export interface ScriptSentence {
  sentence: string;
  words: { id: string; text: string }[];
}

// The reel's sentences, in order, each with its words and their ids.
export function scriptOf(transcript: Transcript, preset: Preset): ScriptSentence[] {
  const index = new Map(transcript.words.map((word, at) => [word.id, at]));
  return sentenceSpans(transcript).map(({ from, to }) => {
    const span = transcript.words.slice(index.get(from)!, index.get(to)! + 1);
    return {
      sentence: wordsText(
        span.map((word) => word.id),
        transcript,
        preset,
      ),
      words: span.map((word) => ({ id: word.id, text: word.text.trim() })),
    };
  });
}

// The speech's length in seconds: the first word's start to the last word's end
// (0 with no words).
export function speechSeconds(transcript: Transcript): number {
  const first = transcript.words[0];
  const last = transcript.words.at(-1);
  if (!first || !last) return 0;
  return Math.max(0, last.end - first.start);
}

// How many picks the components prompt asks for: the speech over the preset's
// seconds per pick at the reel's level, at least one.
export function targetPicks(transcript: Transcript, preset: Preset): number {
  const every = preset.picksEverySeconds[preset.intensity];
  return Math.max(1, Math.round(speechSeconds(transcript) / every));
}

// What the components prompt is filled with: the script, the written hook
// (data, never a component), and the reel's intensity and target. Nothing else:
// no current choices, no glossary, no preset layout, no stored rules; the
// engine checks the answer against those.
export interface DecideInput {
  script: ScriptSentence[];
  hook: { text: string };
  intensity: Intensity;
  target_picks: number;
}

export function decideInput({
  transcript,
  preset,
  hook,
}: {
  transcript: Transcript;
  preset: Preset;
  // The written hook the reel opens with (decided by its own call this run).
  hook: { text: string };
}): DecideInput {
  return {
    script: scriptOf(transcript, preset),
    hook: { text: hook.text },
    intensity: preset.intensity,
    target_picks: targetPicks(transcript, preset),
  };
}
