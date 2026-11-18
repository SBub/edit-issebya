import { describe, expect, it } from "vitest";
import {
  ALIGN_SETTINGS,
  VOCABULARY_SIZE,
  alignDecodeArgs,
  alignedTranscript,
  chunksOf,
  forcedAlign,
  logSoftmax,
  normaliseSamples,
  transcriptTokens,
  wordTokens,
} from "./align.ts";
import { ALIGN_MODEL } from "./align-model.ts";
import type { Word } from "./transcript.ts";

const FRAME = ALIGN_SETTINGS.samplesPerFrame / ALIGN_SETTINGS.sampleRate;

function word(id: number, text: string, start = 0, end = 0): Word {
  return { id: `w${String(id).padStart(4, "0")}`, text, start, end };
}

// Emissions where frame t is sure of `labels[t]` (log probability near 0).
function emissionsOf(labels: number[]): Float32Array {
  const logits = new Float32Array(labels.length * VOCABULARY_SIZE).fill(-10);
  labels.forEach((label, t) => {
    logits[t * VOCABULARY_SIZE + label] = 10;
  });
  return logSoftmax(logits, labels.length, VOCABULARY_SIZE);
}

describe("aligner settings", () => {
  it("name the pinned model, so another model re-runs transcribe", () => {
    expect(ALIGN_SETTINGS.model).toBe(ALIGN_MODEL.file);
    expect(ALIGN_SETTINGS.modelSha256).toBe(ALIGN_MODEL.sha256);
    expect(FRAME).toBeCloseTo(0.02, 9);
  });

  it("decode the audio to 16 kHz mono floats on stdout", () => {
    expect(alignDecodeArgs("/job/converted.mp4").join(" ")).toBe(
      "-hide_banner -v error -i /job/converted.mp4 -vn -ac 1 -ar 16000 -f f32le pipe:1",
    );
  });
});

describe("wordTokens", () => {
  it("spells a word in the model's capitals, the apostrophe kept, punctuation dropped", () => {
    // D=14 O=8 N=9 '=27 T=6
    expect(wordTokens("Don't,")).toEqual([14, 8, 9, 27, 6]);
    // Accents dropped: é is E (5).
    expect(wordTokens("café")).toEqual([19, 7, 20, 5]);
  });

  it("has nothing for digits and symbols", () => {
    expect(wordTokens("2026")).toEqual([]);
    expect(wordTokens("%")).toEqual([]);
  });
});

describe("normaliseSamples", () => {
  it("gives zero mean and unit variance", () => {
    const out = normaliseSamples(Float32Array.from([1, 2, 3, 4]));
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    const variance = out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length;
    expect(mean).toBeCloseTo(0, 6);
    expect(variance).toBeCloseTo(1, 4);
  });
});

describe("chunksOf", () => {
  it("keeps frames that tile the clip exactly, with context around each piece", () => {
    const samples = 45 * ALIGN_SETTINGS.sampleRate + 123;
    const chunks = chunksOf(samples);
    expect(chunks.map((c) => c.count)).toEqual([1000, 1000, 250]);
    let next = 0;
    for (const chunk of chunks) {
      expect(chunk.first).toBe(next);
      next += chunk.count;
      // The kept frames' samples are inside what the model hears.
      expect(chunk.from).toBe((chunk.first - chunk.skip) * 320);
      expect(chunk.to).toBeLessThanOrEqual(samples);
    }
    expect(next).toBe(Math.floor(samples / 320));
    expect(chunks[0]!.skip).toBe(0);
    expect(chunks[1]!.skip).toBe(50);
    expect(chunks[1]!.to).toBe((2000 + 50 - 1) * 320 + 400);
  });
});

describe("forcedAlign", () => {
  it("finds each letter where the model hears it, blanks around", () => {
    // blank blank H H blank I blank blank: "HI" (H=11, I=10).
    const spans = forcedAlign(
      emissionsOf([0, 0, 11, 11, 0, 10, 0, 0]),
      8,
      VOCABULARY_SIZE,
      [11, 10],
    );
    expect(spans).toEqual([
      { first: 2, last: 3 },
      { first: 5, last: 5 },
    ]);
  });

  it("keeps a repeated letter apart with a blank between", () => {
    // "LL" (L=15): two letters need a blank between them.
    const spans = forcedAlign(emissionsOf([15, 0, 15]), 3, VOCABULARY_SIZE, [15, 15]);
    expect(spans).toEqual([
      { first: 0, last: 0 },
      { first: 2, last: 2 },
    ]);
  });

  it("refuses more letters than the audio has frames", () => {
    expect(() => forcedAlign(emissionsOf([0, 0]), 2, VOCABULARY_SIZE, [11, 10, 11])).toThrow(
      "3 letters do not fit in 2 frames of audio",
    );
  });
});

describe("transcriptTokens and alignedTranscript", () => {
  it("joins words with the separator and times each by its own letters", () => {
    const words = [word(1, "Hi", 0, 9), word(2, "a", 0, 9)];
    const { tokens, owned } = transcriptTokens(words);
    expect(tokens).toEqual([11, 10, 4, 7]);
    expect(owned).toEqual([[0, 1], [3]]);
    const spans = [
      { first: 10, last: 12 },
      { first: 13, last: 20 },
      { first: 21, last: 21 },
      { first: 40, last: 44 },
    ];
    const aligned = alignedTranscript(words, owned, spans, FRAME, 2);
    expect(aligned).toEqual([
      { id: "w0001", text: "Hi", start: 0.2, end: 0.42 },
      { id: "w0002", text: "a", start: 0.8, end: 0.9 },
    ]);
  });

  it("shares the gap between placed neighbours among the words it cannot spell", () => {
    const words = [word(1, "in"), word(2, "2026"), word(3, "%"), word(4, "we")];
    const { tokens, owned } = transcriptTokens(words);
    // "IN" | "WE": the digits and the symbol own no token.
    expect(tokens).toEqual([10, 9, 4, 18, 5]);
    expect(owned).toEqual([[0, 1], [], [], [3, 4]]);
    const spans = [
      { first: 0, last: 0 },
      { first: 1, last: 4 },
      { first: 5, last: 5 },
      { first: 55, last: 55 },
      { first: 56, last: 59 },
    ];
    const aligned = alignedTranscript(words, owned, spans, FRAME, 2);
    expect(aligned.map(({ start, end }) => [start, end])).toEqual([
      [0, 0.1],
      [0.1, 0.6],
      [0.6, 1.1],
      [1.1, 1.2],
    ]);
  });

  it("gives an unspellable first or last word the time from the clip's edge", () => {
    const words = [word(1, "1"), word(2, "go"), word(3, "2")];
    const { owned } = transcriptTokens(words);
    const spans = [
      { first: 25, last: 25 },
      { first: 26, last: 29 },
    ];
    const aligned = alignedTranscript(words, owned, spans, FRAME, 1);
    expect(aligned.map(({ start, end }) => [start, end])).toEqual([
      [0, 0.5],
      [0.5, 0.6],
      [0.6, 1],
    ]);
  });

  it("keeps Whisper's times when no word can be spelled", () => {
    const words = [word(1, "42", 1, 2)];
    expect(alignedTranscript(words, [[]], [], FRAME, 3)).toEqual(words);
  });
});
