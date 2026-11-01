// The studio's transcript (`Word`, `Transcript`): one definition, in
// @edit-issebya/edit, shared with the builder.
import type { Transcript, Word } from "@edit-issebya/edit";

export type { Transcript, Word };

function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function wordId(index: number): string {
  return `w${String(index + 1).padStart(4, "0")}`;
}

// HyperFrames' word list (`[{ text, start, end, id? }]`) as a transcript:
// text trimmed, empty words dropped, times to the millisecond, a word never
// starting before the one before it nor ending before it starts, ids by
// position. Its own ids are ignored.
export function normaliseHyperframes(raw: unknown): Transcript {
  if (!Array.isArray(raw)) throw new Error("transcribe: HyperFrames result is not a word list");
  const words: Word[] = [];
  let previousStart = 0;
  for (const [index, item] of raw.entries()) {
    const { text, start, end } = (item ?? {}) as { text?: unknown; start?: unknown; end?: unknown };
    if (typeof text !== "string" || typeof start !== "number" || typeof end !== "number") {
      throw new Error(`transcribe: word ${index} is malformed: ${JSON.stringify(item)}`);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`transcribe: word ${index} has no time: ${JSON.stringify(item)}`);
    }
    const trimmed = text.trim();
    if (trimmed === "") continue;
    const wordStart = Math.max(ms(start), previousStart);
    previousStart = wordStart;
    words.push({
      id: wordId(words.length),
      text: trimmed,
      start: wordStart,
      end: Math.max(ms(end), wordStart),
    });
  }
  if (words.length === 0) throw new Error("transcribe: no words heard");
  return { words };
}

// The same words at new times (a retime's map): ids and texts unchanged.
export function remapTranscript(transcript: Transcript, map: (t: number) => number): Transcript {
  return {
    words: transcript.words.map((word) => ({
      ...word,
      start: ms(map(word.start)),
      end: ms(map(word.end)),
    })),
  };
}

// A stored transcript read back, checked enough for the planner.
export function parseTranscript(json: string): Transcript {
  const parsed = JSON.parse(json) as Partial<Transcript>;
  if (!Array.isArray(parsed.words)) throw new Error("transcript: no word list");
  return { words: parsed.words };
}
