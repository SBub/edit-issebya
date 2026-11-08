import { ISSEBYA_PRESET, type Transcript, sentenceSpans } from "@edit-issebya/edit";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideInput, scriptOf, speechAfterHookSeconds, targetPicks } from "./input.ts";

const word = (id: string, text: string, start: number, end: number) => ({ id, text, start, end });

// Two sentences ended by punctuation, a third after a pause.
const transcript = {
  words: [
    word("w1", "Photos", 0, 0.4),
    word("w2", "help.", 0.45, 0.9),
    word("w3", "Do", 1, 1.2),
    word("w4", "they?", 1.25, 1.6),
    word("w5", "Yes", 1.7, 2),
    word("w6", "always", 2.7, 3.2),
  ],
} as unknown as Transcript;

describe("sentenceSpans", () => {
  it("splits on ending punctuation and on a pause of 0.6 s", () => {
    expect(sentenceSpans(transcript)).toEqual([
      { from: "w1", to: "w2", start: 0, end: 0.9 },
      { from: "w3", to: "w4", start: 1, end: 1.6 },
      { from: "w5", to: "w5", start: 1.7, end: 2 },
      { from: "w6", to: "w6", start: 2.7, end: 3.2 },
    ]);
  });

  it("is empty without words", () => {
    expect(sentenceSpans({ words: [] } as unknown as Transcript)).toEqual([]);
  });
});

describe("scriptOf", () => {
  it("gives each sentence its text and its words with their ids, no times", () => {
    // Every word of this clip starts before the hook ends, so each carries the flag.
    expect(scriptOf(transcript, ISSEBYA_PRESET)).toEqual([
      {
        sentence: "photos help",
        words: [
          { id: "w1", text: "Photos", under_hook: true },
          { id: "w2", text: "help.", under_hook: true },
        ],
      },
      {
        sentence: "do they",
        words: [
          { id: "w3", text: "Do", under_hook: true },
          { id: "w4", text: "they?", under_hook: true },
        ],
      },
      { sentence: "yes", words: [{ id: "w5", text: "Yes", under_hook: true }] },
      { sentence: "always", words: [{ id: "w6", text: "always", under_hook: true }] },
    ]);
  });

  it("flags a word that starts before the hook ends, and only that word", () => {
    const timed = {
      words: [
        word("a", "Look", 0.1, 0.4),
        word("b", "closer", 2.5, 2.9),
        word("c", "now", 2.99, 3.2),
        word("d", "after", 3, 3.4),
        word("e", "that.", 3.6, 4),
      ],
    } as unknown as Transcript;
    const words = scriptOf(timed, ISSEBYA_PRESET).flatMap((sentence) => sentence.words);
    expect(words.map((w) => w.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(words.map((w) => w.under_hook)).toEqual([true, true, true, undefined, undefined]);
    // The flag is omitted, not false, on the other words.
    expect(words[3]).not.toHaveProperty("under_hook");
    expect(words[4]).not.toHaveProperty("under_hook");
  });
});

describe("speechAfterHookSeconds and targetPicks", () => {
  it("measures the speech from the hook's end (or the first word, if later) to the last word's end", () => {
    // Every word of the clip starts before the hook ends at 3 s; the last word ends at 3.2 s.
    expect(speechAfterHookSeconds(transcript, ISSEBYA_PRESET)).toBeCloseTo(0.2, 5);
    expect(speechAfterHookSeconds({ words: [] } as unknown as Transcript, ISSEBYA_PRESET)).toBe(0);
    const late = {
      words: [word("a", "Go", 4, 4.5), word("b", "on.", 5, 6)],
    } as unknown as Transcript;
    expect(speechAfterHookSeconds(late, ISSEBYA_PRESET)).toBeCloseTo(2, 5);
  });

  it("divides the speech after the hook by the preset's seconds per pick at the reel's level", () => {
    // 0.2 s after the hook at intense (2.5 s per pick) rounds to 0, so at least 1.
    expect(targetPicks(transcript, ISSEBYA_PRESET)).toBe(1);
    // 57 s after the hook (3 s to 60 s): 22.8 picks at intense, 12.7 at medium, 5.7 at calm.
    const long = {
      words: [word("a", "Go", 0, 0.5), word("b", "on.", 59, 60)],
    } as unknown as Transcript;
    expect(targetPicks(long, ISSEBYA_PRESET)).toBe(23);
    expect(targetPicks(long, { ...ISSEBYA_PRESET, intensity: "medium" })).toBe(13);
    expect(targetPicks(long, { ...ISSEBYA_PRESET, intensity: "calm" })).toBe(6);
  });

  it("ignores the hook window: speech under the hook adds no picks", () => {
    // Speech from 0 s to 3 s only: all of it is under the hook, so one pick.
    const underHook = {
      words: [word("a", "Go", 0, 1), word("b", "on.", 2, 2.9)],
    } as unknown as Transcript;
    expect(targetPicks(underHook, ISSEBYA_PRESET)).toBe(1);
    // The same 57 s of speech, starting at 3 s, counts as it would starting at 0 s
    // with the hook's 3 s removed: 4 to 60 s is 56 s, 22.4 picks at intense.
    const lateStart = {
      words: [word("a", "Go", 4, 4.5), word("b", "on.", 59, 60)],
    } as unknown as Transcript;
    expect(targetPicks(lateStart, ISSEBYA_PRESET)).toBe(22);
  });

  it("is at least one pick, also for an empty transcript", () => {
    expect(targetPicks({ words: [] } as unknown as Transcript, ISSEBYA_PRESET)).toBe(1);
  });
});

describe("decideInput", () => {
  const read = (path: string): unknown =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const real = read("../../../../fixtures/pipeline/retime/transcript.json") as Transcript;

  it("carries exactly the script, the hook, the intensity and the target: no glossary", () => {
    const input = decideInput({
      transcript: real,
      preset: ISSEBYA_PRESET,
      hook: { text: "Hi" },
    });
    expect(Object.keys(input).sort()).toEqual(
      ["hook", "intensity", "script", "target_picks"].sort(),
    );
    expect(input.hook).toEqual({ text: "Hi" });
    expect(input.intensity).toBe("intense");
    expect(input.target_picks).toBe(targetPicks(real, ISSEBYA_PRESET));
    expect(input.script.flatMap((sentence) => sentence.words)).toHaveLength(real.words.length);
  });
});
