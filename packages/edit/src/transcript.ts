import { z } from "zod";

// The studio's transcript (`transcript.json`, written by transcribe and
// retime): every word with a stable id given once and never changed, times
// in seconds to the millisecond.
export interface Word {
  id: string;
  text: string;
  start: number;
  end: number;
}

// The speaker's voice as measured on the retimed footage's sound (retime
// writes it): one RMS level and one sample peak, in dBFS, for every window of
// `windowSeconds` (0.1 s) from the reel's start. What a sound mixed over the
// voice takes its level from (`sounds.ts`: the typed hook's key sounds). A
// transcript written before this measure has none.
export interface Voice {
  windowSeconds: number;
  levels: number[];
  peaks: number[];
}

export interface Transcript {
  words: Word[];
  voice?: Voice;
}

const wordSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    start: z.number().min(0),
    end: z.number().min(0),
  })
  .refine((word) => word.end >= word.start, { message: "a word ends before it starts" });

const voiceSchema = z
  .object({
    windowSeconds: z.number().positive(),
    levels: z.array(z.number()),
    peaks: z.array(z.number()),
  })
  .refine((voice) => voice.levels.length === voice.peaks.length, {
    message: "the voice has a level and a peak for every window",
  });

export const transcriptSchema = z
  .object({ words: z.array(wordSchema), voice: voiceSchema.optional() })
  .superRefine((transcript, ctx) => {
    const seen = new Set<string>();
    for (const word of transcript.words) {
      if (seen.has(word.id)) ctx.addIssue({ code: "custom", message: `word id ${word.id} twice` });
      seen.add(word.id);
    }
  });

// A pause this long between two words ends a spoken sentence.
const SENTENCE_PAUSE_SECONDS = 0.6;

export interface SentenceSpan {
  from: string;
  to: string;
  start: number;
  end: number;
}

// The transcript's words grouped into spoken sentences: a sentence ends after
// a word ending in `.`, `?` or `!`, or before a pause of at least
// SENTENCE_PAUSE_SECONDS.
export function sentenceSpans(transcript: Transcript): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let open: SentenceSpan | null = null;
  transcript.words.forEach((word, index) => {
    open ??= { from: word.id, to: word.id, start: word.start, end: word.end };
    open.to = word.id;
    open.end = word.end;
    const next = transcript.words[index + 1];
    const ends = /[.?!]["')\]]*$/.test(word.text.trim());
    if (!next || ends || next.start - word.end >= SENTENCE_PAUSE_SECONDS) {
      spans.push(open);
      open = null;
    }
  });
  return spans;
}
