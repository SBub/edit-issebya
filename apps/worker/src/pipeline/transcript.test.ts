import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normaliseHyperframes, parseTranscript, remapTranscript } from "./transcript.ts";

const WHISPER = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  readFileSync(
    new URL("testdata/rethink-work/transcript-1x-whisper.json", import.meta.url),
    "utf8",
  ),
) as { text: string; start: number; end: number; id: string }[];

describe("normaliseHyperframes", () => {
  it("keeps every word of the reference, in order, with ids by position", () => {
    const { words } = normaliseHyperframes(WHISPER);
    expect(words).toHaveLength(WHISPER.length);
    expect(words[0]).toEqual({ id: "w0001", text: "The", start: 0.23, end: 0.31 });
    words.forEach((word, index) => {
      expect(word.id).toBe(`w${String(index + 1).padStart(4, "0")}`);
      expect(word.text).toBe(WHISPER[index]!.text.trim());
      expect(word.end).toBeGreaterThanOrEqual(word.start);
      if (index > 0) expect(word.start).toBeGreaterThanOrEqual(words[index - 1]!.start);
    });
  });

  it("trims, drops empty words, rounds to ms and repairs order", () => {
    expect(
      normaliseHyperframes([
        { text: " Hello ", start: 0.12345, end: 0.5, id: "w0" },
        { text: "  ", start: 0.5, end: 0.6 },
        { text: "world", start: 0.4, end: 0.3 },
      ]),
    ).toEqual({
      words: [
        { id: "w0001", text: "Hello", start: 0.123, end: 0.5 },
        { id: "w0002", text: "world", start: 0.4, end: 0.4 },
      ],
    });
    expect(
      normaliseHyperframes([
        { text: "a", start: 1, end: 1.2 },
        { text: "b", start: 0.9, end: 1.3 },
      ]).words[1],
    ).toEqual({ id: "w0002", text: "b", start: 1, end: 1.3 });
  });

  it("fails clearly on an empty or malformed result", () => {
    expect(() => normaliseHyperframes([])).toThrow("transcribe: no words heard");
    expect(() => normaliseHyperframes([{ text: " ", start: 0, end: 0 }])).toThrow("no words");
    expect(() => normaliseHyperframes({ words: [] })).toThrow("not a word list");
    expect(() => normaliseHyperframes([{ text: "a", start: "0" }])).toThrow("word 0 is malformed");
  });
});

describe("remapTranscript", () => {
  it("moves the times and keeps ids and texts", () => {
    const transcript = normaliseHyperframes([
      { text: "a", start: 1, end: 2 },
      { text: "b", start: 2, end: 3.3333 },
    ]);
    expect(remapTranscript(transcript, (t) => t / 2)).toEqual({
      words: [
        { id: "w0001", text: "a", start: 0.5, end: 1 },
        { id: "w0002", text: "b", start: 1, end: 1.667 },
      ],
    });
  });
});

describe("parseTranscript", () => {
  it("reads a stored transcript and refuses one without words", () => {
    expect(parseTranscript('{"words":[]}')).toEqual({ words: [] });
    expect(() => parseTranscript("[]")).toThrow("no word list");
  });
});
