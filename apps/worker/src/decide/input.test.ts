import { ISSEBYA_PRESET, type Transcript, sentenceSpans } from "@edit-issebya/edit";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideInput, scriptOf, speechSeconds, targetPicks } from "./input.ts";

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
    expect(scriptOf(transcript, ISSEBYA_PRESET)).toEqual([
      {
        sentence: "photos help",
        words: [
          { id: "w1", text: "Photos" },
          { id: "w2", text: "help." },
        ],
      },
      {
        sentence: "do they",
        words: [
          { id: "w3", text: "Do" },
          { id: "w4", text: "they?" },
        ],
      },
      { sentence: "yes", words: [{ id: "w5", text: "Yes" }] },
      { sentence: "always", words: [{ id: "w6", text: "always" }] },
    ]);
  });
});

describe("speechSeconds and targetPicks", () => {
  it("measures the speech from the first word's start to the last word's end", () => {
    expect(speechSeconds(transcript)).toBeCloseTo(3.2, 5);
    expect(speechSeconds({ words: [] } as unknown as Transcript)).toBe(0);
  });

  it("divides the speech by the preset's seconds per pick at the reel's level", () => {
    // 3.2 s at intense (2.5 s per pick) rounds to 1.
    expect(targetPicks(transcript, ISSEBYA_PRESET)).toBe(1);
    const long = {
      words: [word("a", "Go", 0, 0.5), word("b", "on.", 59, 60)],
    } as unknown as Transcript;
    expect(targetPicks(long, ISSEBYA_PRESET)).toBe(24);
    expect(targetPicks(long, { ...ISSEBYA_PRESET, intensity: "medium" })).toBe(13);
    expect(targetPicks(long, { ...ISSEBYA_PRESET, intensity: "calm" })).toBe(6);
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
