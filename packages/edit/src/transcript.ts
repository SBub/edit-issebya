// The studio's transcript: every word with a stable id (`w0001`), given once
// by transcribe and never changed by a later step. Times in seconds, to the
// millisecond.
export interface Word {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface Transcript {
  words: Word[];
}

// One head-track sample in 1080x1920 pixels: the head's top row, its centre
// column and its width, at `t` seconds.
export interface HeadSample {
  t: number;
  head_top: number;
  cx: number;
  head_w: number;
}

// One entry per sample; null where no head was found.
export type HeadTrack = (HeadSample | null)[];

export function wordIndex(transcript: Transcript): Map<string, Word> {
  return new Map(transcript.words.map((word) => [word.id, word]));
}
