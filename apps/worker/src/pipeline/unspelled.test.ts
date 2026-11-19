import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALIGN_SETTINGS } from "./align.ts";
import { planRetime, remapTime } from "./retime-plan.ts";
import { RETIME_PRESET } from "./retime-preset.ts";
import { type Word, numberWords } from "./transcript.ts";
import { placeUnspelled } from "./unspelled.ts";

// Words from "text@start-end" pieces.
function wordsOf(...pieces: string[]): Word[] {
  return numberWords(
    pieces.map((piece) => {
      const [text, times] = piece.split("@") as [string, string];
      const [start, end] = times.split("-").map(Number) as [number, number];
      return { text, start, end };
    }),
  );
}

// Speech (-20 dB) in the given runs, room noise (-50 dB) elsewhere.
function envelopeOf(seconds: number, loud: [number, number][]): number[] {
  return Array.from({ length: Math.round(seconds * 100) }, (_, frame) => {
    const t = (frame + 0.5) / 100;
    return loud.some(([a, b]) => t > a && t < b) ? -20 : -50;
  });
}

const times = (words: readonly Word[]) => words.map(({ start, end }) => [start, end]);

describe("placeUnspelled", () => {
  // "-" has no letters in any spoken form: the aligner left it the whole
  // space between "in" and "How", 1.2 to 7 s.
  const words = wordsOf("in@1-1.2", "-@1.2-7", "How@7-7.3");
  const speech: [number, number][] = [
    [1, 1.2],
    [7, 7.3],
  ];

  it("narrows the word to the sound in its space, plus the margin", () => {
    const envelope = envelopeOf(8, [...speech, [1.3, 1.8]]);
    const placed = placeUnspelled({ words, envelope, language: "en" });
    expect(times(placed)).toEqual([
      [1, 1.2],
      [1.3, 1.85],
      [7, 7.3],
    ]);
    expect(placed.map((word) => [word.id, word.text])).toEqual(
      words.map((word) => [word.id, word.text]),
    );
  });

  it("joins the sound over a short break and leaves out a far, smaller burst", () => {
    // 1.3 to 1.5 and 1.7 to 1.9 are one sound (0.2 s apart); the click at 5 s is not.
    const envelope = envelopeOf(8, [...speech, [1.3, 1.5], [1.7, 1.9], [5, 5.02]]);
    expect(times(placeUnspelled({ words, envelope, language: "en" }))[1]).toEqual([1.3, 1.95]);
  });

  it("takes the larger sound when two are apart", () => {
    const envelope = envelopeOf(8, [...speech, [2, 2.03], [4, 4.6]]);
    expect(times(placeUnspelled({ words, envelope, language: "en" }))[1]).toEqual([4, 4.65]);
  });

  it("never lets the margin pass the space", () => {
    const envelope = envelopeOf(8, [...speech, [6.5, 7]]);
    expect(times(placeUnspelled({ words, envelope, language: "en" }))[1]).toEqual([6.5, 7]);
  });

  it("gives a short nominal span at the space's start when it holds no sound", () => {
    const envelope = envelopeOf(8, speech);
    expect(times(placeUnspelled({ words, envelope, language: "en" }))).toEqual([
      [1, 1.2],
      [1.2, 1.3],
      [7, 7.3],
    ]);
    expect(ALIGN_SETTINGS.unspelled.nominalSeconds).toBe(0.1);
  });

  it("keeps the nominal span inside a space shorter than it", () => {
    const tight = wordsOf("in@1-1.2", "-@1.2-1.24", "How@1.24-1.5");
    const envelope = envelopeOf(3, []);
    expect(times(placeUnspelled({ words: tight, envelope, language: "en" }))[1]).toEqual([
      1.2, 1.24,
    ]);
  });

  it("splits one sound evenly among neighbouring unspelled words, in order", () => {
    const two = wordsOf("in@1-1.2", "-@1.2-4.1", "...@4.1-7", "How@7-7.3");
    const envelope = envelopeOf(8, [...speech, [2, 2.75]]);
    expect(times(placeUnspelled({ words: two, envelope, language: "en" }))).toEqual([
      [1, 1.2],
      [2, 2.4],
      [2.4, 2.8],
      [7, 7.3],
    ]);
    const silent = envelopeOf(8, speech);
    expect(times(placeUnspelled({ words: two, envelope: silent, language: "en" }))).toEqual([
      [1, 1.2],
      [1.2, 1.3],
      [1.3, 1.4],
      [7, 7.3],
    ]);
  });

  it("places an unspelled word at the clip's edges the same way", () => {
    const edges = wordsOf("-@0-2", "go@2-2.2", "-@2.2-5");
    const envelope = envelopeOf(5, [
      [1.5, 2.2],
      [2.3, 2.6],
    ]);
    expect(times(placeUnspelled({ words: edges, envelope, language: "en" }))).toEqual([
      [1.5, 2],
      [2, 2.2],
      [2.3, 2.65],
    ]);
  });

  it("never moves a word the model spelled, digits in English included", () => {
    const spelled = wordsOf("in@1-1.2", "2027.@1.2-7", "How@7-7.3");
    const envelope = envelopeOf(8, speech);
    expect(placeUnspelled({ words: spelled, envelope, language: "en" })).toEqual(spelled);
    // The same digits in a language without a spoken form are placed by the sound.
    expect(times(placeUnspelled({ words: spelled, envelope, language: "xx" }))[1]).toEqual([
      1.2, 1.3,
    ]);
  });

  it("returns a transcript with no spelled word as it is (Whisper's times)", () => {
    const none = wordsOf("-@1-2", "...@3-4");
    expect(placeUnspelled({ words: none, envelope: envelopeOf(5, []), language: "en" })).toEqual(
      none,
    );
  });
});

// The owner's reel 3bb61f07, its first 22.5 s: the stored transcript of
// transcribe version 3 and the 10 ms envelope. She says "... on social media
// in twenty twenty-seven", waits 5.5 s (room noise at about -50 dB) and goes
// on with "How to reuse". Whisper wrote "2027."; version 3 could not spell it
// and gave it everything between "in" and "How", 12.20 to 17.96 s, so the
// pause sat inside a word and retime kept it.
describe("the year on the owner's reel", () => {
  const read = <T>(name: string): T =>
    JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
      readFileSync(new URL(`testdata/year-pause/${name}`, import.meta.url), "utf8"),
    ) as T;
  const stored = read<{ words: Word[] }>("transcript-aligned-v3.json").words;
  const envelope = read<number[]>("envelope.json");
  const durationSeconds = envelope.length * RETIME_PRESET.envelopeFrameSeconds;
  const FRAME = 1 / RETIME_PRESET.frameRate;
  const YEAR = 10;
  const HOW = 11;

  // The retimed seconds between the year's end and "How", and of the clip.
  function retimed(words: readonly Word[]) {
    const plan = planRetime({ words, envelope, durationSeconds, settings: RETIME_PRESET });
    const at = (t: number) => remapTime(plan, t);
    return {
      pause: at(words[HOW]!.start) - at(words[YEAR]!.end),
      year: at(words[YEAR]!.end) - at(words[YEAR]!.start),
      clip: plan.durationSeconds,
    };
  }

  it("held the pause inside the word before: 5.76 s, 5.2 s once retimed", () => {
    expect(stored[YEAR]).toEqual({ id: "w0011", text: "2027.", start: 12.2, end: 17.96 });
    const before = retimed(stored);
    expect(before.pause).toBe(0);
    expect(before.year).toBeCloseTo(5.236, 2);
    expect(before.clip).toBeCloseTo(12.967, 2);
  });

  it("with the fallback alone gets a short span, and retime cuts the pause to 0.3 s", () => {
    // A language without a spoken form: "2027." has no letters, as in version 3.
    const placed = placeUnspelled({ words: stored, envelope, language: "xx" });
    expect(placed[YEAR]).toEqual({ id: "w0011", text: "2027.", start: 12.2, end: 12.49 });
    expect(placed.filter((_, index) => index !== YEAR)).toEqual(
      stored.filter((_, index) => index !== YEAR),
    );
    // 5.47 s of the original are now a gap of the transcript.
    expect(placed[HOW]!.start - placed[YEAR]!.end).toBeCloseTo(5.47, 9);
    const after = retimed(placed);
    expect(Math.abs(after.pause - RETIME_PRESET.maxPauseSeconds!)).toBeLessThan(FRAME);
    expect(after.pause).toBeCloseTo(0.283, 2);
    expect(after.clip).toBeCloseTo(8.071, 2);
  });

  it("with the spoken form sits on the spoken year, and the pause is cut the same", () => {
    // What the real aligner (wav2vec2, this machine) gave when it spelled
    // "2027." as TWENTY|TWENTY|SEVEN on this reel's audio: "media" no longer
    // stretched over the year, "in" before it, the year 0.98 s long. Measured
    // on the reel's retimed copy and mapped back to the original's seconds.
    const aligned = stored.map((word) => ({ ...word }));
    Object.assign(aligned[8]!, { start: 10.62, end: 10.92 });
    Object.assign(aligned[9]!, { start: 11.1, end: 11.14 });
    Object.assign(aligned[YEAR]!, { start: 11.22, end: 12.2 });
    expect(aligned.slice(8, 11).map((word) => word.text)).toEqual(["media", "in", "2027."]);
    // English spells every word of this transcript: the fallback moves nothing.
    expect(placeUnspelled({ words: aligned, envelope, language: "en" })).toEqual(aligned);
    const after = retimed(aligned);
    expect(Math.abs(after.pause - RETIME_PRESET.maxPauseSeconds!)).toBeLessThan(FRAME);
    expect(after.pause).toBeCloseTo(0.304, 2);
    expect(after.year).toBeCloseTo(0.891, 2);
    expect(after.clip).toBeCloseTo(7.873, 2);
  });
});
