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

export interface Transcript {
  words: Word[];
}

const wordSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    start: z.number().min(0),
    end: z.number().min(0),
  })
  .refine((word) => word.end >= word.start, { message: "a word ends before it starts" });

export const transcriptSchema = z
  .object({ words: z.array(wordSchema) })
  .superRefine((transcript, ctx) => {
    const seen = new Set<string>();
    for (const word of transcript.words) {
      if (seen.has(word.id)) ctx.addIssue({ code: "custom", message: `word id ${word.id} twice` });
      seen.add(word.id);
    }
  });
