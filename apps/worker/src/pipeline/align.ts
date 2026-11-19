// The pure parts of the word aligner (align-entry.ts runs them): Whisper says
// which words were spoken, a CTC speech model (wav2vec2, its letters and a
// word separator) says where each one starts and ends. The model gives, for
// every 20 ms of audio, the log probability of each letter and of "nothing";
// the forced alignment finds the single most probable path through the known
// letters in order (Viterbi over the CTC states), and a word lasts from the
// first frame of its first letter to the end of the last frame of its last
// letter. No rule of our own moves a time.
import type { Word } from "./transcript.ts";
import { ALIGN_MODEL } from "./align-model.ts";
import { spokenParts } from "./spoken-form.ts";

// Every aligner setting; part of transcribe's fingerprint.
export const ALIGN_SETTINGS = {
  model: ALIGN_MODEL.file,
  modelSha256: ALIGN_MODEL.sha256,
  // The model's input rate and its output step: one frame per 320 samples,
  // each frame hearing 400 samples (its convolutions' receptive field).
  sampleRate: 16_000,
  samplesPerFrame: 320,
  receptiveSamples: 400,
  // The audio goes through the model in pieces of chunkSeconds, each with
  // contextSeconds of audio on both sides that is heard but not kept, so a
  // piece's edge sounds the same as its middle. Memory stays flat on a long clip.
  chunkSeconds: 20,
  contextSeconds: 1,
  provider: "cpu",
  // A word the model still cannot spell is placed on the sound inside the
  // space it was given (unspelled.ts): the frames no more than belowSpeechDb
  // under the clip's speech level, joined over breaks of up to bridgeSeconds,
  // plus marginSeconds; nominalSeconds per word when the space has no such
  // sound. The envelope's frames are envelopeFrameSeconds long.
  unspelled: {
    belowSpeechDb: 10,
    bridgeSeconds: 0.25,
    marginSeconds: 0.05,
    nominalSeconds: 0.1,
    envelopeFrameSeconds: 0.01,
  },
} as const;

export type AlignSettings = typeof ALIGN_SETTINGS;

// ffmpeg's arguments: the first audio stream as 16 kHz mono 32-bit floats on stdout.
export function alignDecodeArgs(input: string): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(ALIGN_SETTINGS.sampleRate),
    "-f",
    "f32le",
    "pipe:1",
  ];
}

// The model's vocabulary (wav2vec2-base-960h, vocab.json): the blank `<pad>`,
// the word separator `|`, the apostrophe and the 26 capital letters.
const BLANK = 0;
const SEPARATOR = 4;
const LETTERS: Record<string, number> = {
  "'": 27,
  A: 7,
  B: 24,
  C: 19,
  D: 14,
  E: 5,
  F: 20,
  G: 21,
  H: 11,
  I: 10,
  J: 29,
  K: 26,
  L: 15,
  M: 17,
  N: 9,
  O: 8,
  P: 23,
  Q: 30,
  R: 13,
  S: 12,
  T: 6,
  U: 16,
  V: 25,
  W: 18,
  X: 28,
  Y: 22,
  Z: 31,
};
export const VOCABULARY_SIZE = 32;

// A word's letters as model tokens: accents dropped, capitals, only what the
// model spells (letters and the apostrophe). "Don't," is D O N ' T; "2026" and
// "%" have none of their own (spokenTokens reads them first).
export function wordTokens(text: string): number[] {
  return [...text.normalize("NFD").toUpperCase()]
    .map((char) => LETTERS[char])
    .filter((token): token is number => token !== undefined);
}

// The model's input: zero mean, unit variance (the feature extractor's
// do_normalize), as the model was trained.
export function normaliseSamples(samples: Float32Array): Float32Array {
  let sum = 0;
  for (const value of samples) sum += value;
  const mean = samples.length > 0 ? sum / samples.length : 0;
  let squares = 0;
  for (const value of samples) squares += (value - mean) ** 2;
  const deviation = Math.sqrt(squares / Math.max(1, samples.length) + 1e-7);
  return samples.map((value) => (value - mean) / deviation);
}

export interface Chunk {
  // The samples fed to the model, context included.
  from: number;
  to: number;
  // The frames kept: frame `skip` of the model's output is clip frame `first`.
  first: number;
  skip: number;
  count: number;
}

// The pieces of a clip of `samples` samples: cores of chunkSeconds on whole
// frames, each fed with up to contextSeconds of audio before and after. The
// kept frames tile the clip's frames exactly.
export function chunksOf(samples: number, settings: AlignSettings = ALIGN_SETTINGS): Chunk[] {
  const step = settings.samplesPerFrame;
  const total = Math.floor(samples / step);
  const core = Math.round((settings.chunkSeconds * settings.sampleRate) / step);
  const context = Math.round((settings.contextSeconds * settings.sampleRate) / step);
  const chunks: Chunk[] = [];
  for (let first = 0; first < total; first += core) {
    const count = Math.min(core, total - first);
    const before = Math.min(context, first);
    const after = Math.min(context, total - first - count);
    chunks.push({
      from: (first - before) * step,
      to: Math.min(samples, (first + count + after - 1) * step + settings.receptiveSamples),
      first,
      skip: before,
      count,
    });
  }
  return chunks;
}

// Log-softmax of each frame's logits, in place.
export function logSoftmax(logits: Float32Array, frames: number, size: number): Float32Array {
  for (let t = 0; t < frames; t += 1) {
    const row = t * size;
    let max = -Infinity;
    for (let v = 0; v < size; v += 1) max = Math.max(max, logits[row + v]!);
    let sum = 0;
    for (let v = 0; v < size; v += 1) sum += Math.exp(logits[row + v]! - max);
    const log = max + Math.log(sum);
    for (let v = 0; v < size; v += 1) logits[row + v] = logits[row + v]! - log;
  }
  return logits;
}

// The CTC forced alignment of `tokens` over the frames' log probabilities
// (`emissions`, frames x size): the most probable path that spells the tokens
// in order, blanks allowed between and around them, a token held over
// several frames. For each token, the first and last frame it holds.
export function forcedAlign(
  emissions: Float32Array,
  frames: number,
  size: number,
  tokens: readonly number[],
): { first: number; last: number }[] {
  if (tokens.length === 0) return [];
  // The CTC states: blank, token 0, blank, token 1, ..., blank.
  const states = 2 * tokens.length + 1;
  const label = (s: number) => (s % 2 === 0 ? BLANK : tokens[(s - 1) >> 1]!);
  // Two neighbouring tokens that are the same letter need a blank between.
  const repeats = tokens.filter((token, i) => i > 0 && tokens[i - 1] === token).length;
  if (frames < tokens.length + repeats) {
    throw new Error(`${tokens.length} letters do not fit in ${frames} frames of audio`);
  }
  let previous = new Float64Array(states).fill(-Infinity);
  let current = new Float64Array(states);
  // How each state was reached at each frame: 0 stay, 1 from s - 1, 2 from s - 2.
  const moves = new Uint8Array(frames * states);
  previous[0] = emissions[label(0)]!;
  previous[1] = emissions[label(1)]!;
  for (let t = 1; t < frames; t += 1) {
    const row = t * size;
    for (let s = 0; s < states; s += 1) {
      let best = previous[s]!;
      let move = 0;
      if (s >= 1 && previous[s - 1]! > best) {
        best = previous[s - 1]!;
        move = 1;
      }
      if (s >= 2 && s % 2 === 1 && label(s) !== label(s - 2) && previous[s - 2]! > best) {
        best = previous[s - 2]!;
        move = 2;
      }
      current[s] = best + emissions[row + label(s)]!;
      moves[t * states + s] = move;
    }
    [previous, current] = [current, previous];
  }
  let s = previous[states - 1]! >= previous[states - 2]! ? states - 1 : states - 2;
  if (!Number.isFinite(previous[s]!)) throw new Error("no alignment through the audio");
  const spans = tokens.map(() => ({ first: -1, last: -1 }));
  for (let t = frames - 1; t >= 0; t -= 1) {
    if (s % 2 === 1) {
      const span = spans[(s - 1) >> 1]!;
      span.first = t;
      if (span.last < 0) span.last = t;
    }
    if (t > 0) s -= moves[t * states + s]!;
  }
  return spans;
}

function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// Each word as the model's tokens, by its spoken form (spoken-form.ts): the
// letters of every spoken part, the separator between two parts. "2027." is
// TWENTY|TWENTY|SEVEN, "50%" FIFTY|PERCENT, "Don't," D O N ' T. A word with
// nothing the model spells (a lone dash, another script) has none. Only the
// aligner and the re-listen's letter count read this: the stored text of a
// word never changes.
export function spokenTokens(texts: readonly string[], language: string): number[][] {
  return spokenParts(texts, language).map((parts) => {
    const tokens: number[] = [];
    for (const part of parts) {
      const letters = wordTokens(part);
      if (letters.length === 0) continue;
      if (tokens.length > 0) tokens.push(SEPARATOR);
      tokens.push(...letters);
    }
    return tokens;
  });
}

// How many letters each word's spoken form has (separators not counted).
export function spokenLetters(texts: readonly string[], language: string): number[] {
  return spokenTokens(texts, language).map(
    (tokens) => tokens.filter((token) => token !== SEPARATOR).length,
  );
}

// The aligner's tokens for a transcript: each word's spoken tokens, words
// joined by the separator; and, per word, the indices of its own tokens (none
// for a word the model cannot spell). A word of several spoken parts owns all
// of them, so it starts with its first part and ends with its last.
export function transcriptTokens(
  words: readonly Word[],
  language: string,
): {
  tokens: number[];
  owned: number[][];
} {
  const tokens: number[] = [];
  const owned: number[][] = [];
  const spoken = spokenTokens(
    words.map((word) => word.text),
    language,
  );
  for (const own of spoken) {
    if (own.length > 0 && tokens.length > 0) tokens.push(SEPARATOR);
    owned.push(own.map((_, i) => tokens.length + i));
    tokens.push(...own);
  }
  return { tokens, owned };
}

// The transcript at the aligner's times (pure): a word lasts from its first
// letter's first frame to its last letter's last frame end (the first and
// last letters of its spoken form). A word the model cannot spell is not
// placed by the model: it and any such neighbours get the space between the
// placed words around them, evenly, in order (from the clip's start or to its
// end at the edges), and transcribe then narrows that space to its sound
// (unspelled.ts). A transcript with no word the model can spell keeps
// Whisper's times. Ids and texts never change.
export function alignedTranscript(
  words: readonly Word[],
  owned: readonly number[][],
  spans: readonly { first: number; last: number }[],
  frameSeconds: number,
  clipSeconds: number,
): Word[] {
  if (spans.length === 0) return words.map((word) => ({ ...word }));
  const placed = words.map((_, index) => {
    const own = owned[index]!;
    if (own.length === 0) return null;
    return {
      start: ms(spans[own[0]!]!.first * frameSeconds),
      end: ms(Math.min((spans[own.at(-1)!]!.last + 1) * frameSeconds, clipSeconds)),
    };
  });
  const out: Word[] = [];
  let index = 0;
  while (index < words.length) {
    const time = placed[index];
    if (time) {
      out.push({ ...words[index]!, ...time });
      index += 1;
      continue;
    }
    let next = index;
    while (next < words.length && !placed[next]) next += 1;
    const from = out.at(-1)?.end ?? 0;
    const to = placed[next]?.start ?? ms(clipSeconds);
    const each = Math.max(0, to - from) / (next - index);
    for (let k = index; k < next; k += 1) {
      const start = ms(from + (k - index) * each);
      out.push({ ...words[k]!, start, end: ms(Math.max(start, from + (k - index + 1) * each)) });
    }
    index = next;
  }
  return out;
}

// The letter probabilities of a clip as one file, so a second alignment of
// the same audio (transcribe's re-listen changed the words) skips the model:
// the clip's sample count (8 bytes, a double), then the frames' log
// probabilities (float32, frames x size), little-endian.
export function packEmissions(samples: number, emissions: Float32Array): Buffer {
  const out = Buffer.alloc(8 + emissions.length * 4);
  out.writeDoubleLE(samples, 0);
  emissions.forEach((value, index) => out.writeFloatLE(value, 8 + index * 4));
  return out;
}

export function unpackEmissions(
  file: Buffer,
  size: number,
): { samples: number; emissions: Float32Array; frames: number } {
  const values = (file.length - 8) / 4;
  if (file.length < 8 || !Number.isInteger(values / size)) {
    throw new Error(`the saved letter probabilities are damaged (${file.length} bytes)`);
  }
  const emissions = new Float32Array(values);
  for (let index = 0; index < values; index += 1)
    emissions[index] = file.readFloatLE(8 + index * 4);
  return { samples: file.readDoubleLE(0), emissions, frames: values / size };
}
