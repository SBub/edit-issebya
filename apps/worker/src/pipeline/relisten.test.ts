import { describe, expect, it } from "vitest";
import {
  RELISTEN_SETTINGS,
  type Spot,
  applyReplacements,
  heardTexts,
  mergeHeard,
  relistenSpots,
  relistenSummary,
  relistenWindow,
  stretchedWords,
  windowArgs,
} from "./relisten.ts";
import { type Word, numberWords } from "./transcript.ts";
import { RELISTEN_MODEL } from "./whisper-model.ts";

const S = RELISTEN_SETTINGS;

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

// Speech (-20 dB) inside every word and every `loud` run, room noise (-70 dB) elsewhere.
function envelopeOf(words: readonly Word[], seconds: number, loud: [number, number][] = []) {
  const runs = [...words.map((word): [number, number] => [word.start, word.end]), ...loud];
  return Array.from({ length: Math.round(seconds * 100) }, (_, frame) => {
    const t = (frame + 0.5) / 100;
    return runs.some(([a, b]) => t > a && t < b) ? -20 : -70;
  });
}

// The owner's reel b2170604 around its dropped words: "together? [Warm meals
// made from local produce] And hugs instead of more things."
const REEL = wordsOf(
  "when@96.3-96.42",
  "we@96.48-96.56",
  "are@96.64-96.72",
  "together?@96.78-97.22",
  "And@103.3-104.5",
  "hugs@109.26-109.56",
  "instead@109.72-110",
  "of@110.06-110.1",
  "more@110.22-110.38",
  "things.@110.44-110.76",
);
const REEL_SPOT: Spot = { start: 102.37, end: 104.97, kinds: ["gap", "word", "gap"] };

describe("re-listen settings", () => {
  it("name whisper medium at its pinned hash, and the approved thresholds", () => {
    expect(S).toMatchObject({
      model: "medium",
      modelSha256: RELISTEN_MODEL.sha256,
      gapSeconds: 0.45,
      stretchRatio: 3,
      stretchExtraSeconds: 0.4,
      joinSeconds: 1,
      windowWords: 3,
      windowPadSeconds: 0.3,
    });
    expect(RELISTEN_MODEL.file).toBe("ggml-medium.bin");
    expect(RELISTEN_MODEL.url).toContain("/ggml-medium.bin");
  });
});

describe("relistenSpots: the gap rule", () => {
  const words = wordsOf("one@1-1.3", "two@1.4-1.7", "three@4-4.3", "four@4.4-4.7");

  it("finds 0.45 s of speech-level sound in a gap of the transcript", () => {
    const envelope = envelopeOf(words, 6, [[2, 2.5]]);
    expect(relistenSpots({ words, envelope, settings: S })).toEqual([
      { start: 2, end: 2.5, kinds: ["gap"] },
    ]);
  });

  it("leaves a shorter burst alone, which retime still keeps as a possible missed word", () => {
    const envelope = envelopeOf(words, 6, [[2, 2.4]]);
    expect(relistenSpots({ words, envelope, settings: S })).toEqual([]);
  });

  it("finds nothing in a quiet gap, however long", () => {
    expect(relistenSpots({ words, envelope: envelopeOf(words, 6), settings: S })).toEqual([]);
  });
});

describe("stretchedWords", () => {
  // Median 0.05 s per letter.
  const steady = ["this@0-0.2", "clip@0.3-0.5", "runs@0.6-0.8", "fine@0.9-1.1"];

  it("finds a word 3 times slower per letter and 0.4 s too long", () => {
    const words = wordsOf(...steady, "And@2-3.2");
    expect(stretchedWords(words, S).map((word) => word.text)).toEqual(["And"]);
  });

  it("leaves a long word that is only long: slow enough per letter, not 0.4 s over", () => {
    // "a" at 0.3 s is 6 times the median but only 0.25 s over it.
    const words = wordsOf(...steady, "a@2-2.3");
    expect(stretchedWords(words, S)).toEqual([]);
  });

  it("leaves a word 0.4 s over that is not 3 times slower per letter", () => {
    // 10 letters in 1.0 s: 0.5 s over the median's 0.5 s, but only twice as slow.
    const words = wordsOf(...steady, "everything@2-3");
    expect(stretchedWords(words, S)).toEqual([]);
  });

  it("skips a word the aligner cannot spell", () => {
    const words = wordsOf(...steady, "2026@2-4");
    expect(stretchedWords(words, S)).toEqual([]);
  });
});

describe("relistenSpots: joining", () => {
  it("joins candidates closer than 1 s into one spot, as on the owner's reel", () => {
    const envelope = envelopeOf(REEL, 113, [
      [102.37, 103.06],
      [104.5, 104.97],
    ]);
    expect(relistenSpots({ words: REEL, envelope, settings: S })).toEqual([
      { start: 102.37, end: 104.97, kinds: ["gap", "word", "gap"] },
    ]);
  });

  it("keeps candidates further apart as spots of their own, in order", () => {
    const words = wordsOf("one@1-1.3", "two@1.4-1.7", "three@6-6.3", "four@6.4-6.7");
    const envelope = envelopeOf(words, 8, [
      [2, 2.5],
      [3.6, 4.1],
    ]);
    expect(relistenSpots({ words, envelope, settings: S })).toEqual([
      { start: 2, end: 2.5, kinds: ["gap"] },
      { start: 3.6, end: 4.1, kinds: ["gap"] },
    ]);
  });
});

describe("relistenWindow", () => {
  it("takes 3 old words on each side and up to 0.3 s of the pauses beyond", () => {
    const words = wordsOf("lead@90-90.5", ...REEL.map((w) => `${w.text}@${w.start}-${w.end}`));
    const window = relistenWindow(REEL_SPOT, words, 113.15, S);
    // "we are together?" before, the stretched "And", "hugs instead of" after.
    expect(words.slice(window.first, window.last + 1).map((word) => word.text)).toEqual([
      "we",
      "are",
      "together?",
      "And",
      "hugs",
      "instead",
      "of",
    ]);
    // Half of the 0.06 s pause before "we", half of the 0.12 s after "of".
    expect(window.from).toBeCloseTo(96.45, 6);
    expect(window.to).toBeCloseTo(110.16, 6);
  });

  it("never reaches further than 0.3 s into a long pause, nor past the clip", () => {
    const words = wordsOf("one@2-2.3", "two@2.4-2.7");
    const window = relistenWindow({ start: 3, end: 3.5, kinds: ["gap"] }, words, 3.6, S);
    expect(window).toEqual({ first: 0, last: 1, from: 1.7, to: 3.55 });
  });

  it("uses the words there are at the clip's start", () => {
    const words = wordsOf("one@2-2.3", "two@2.4-2.7", "three@2.8-3", "four@3.1-3.3", "five@9-9.2");
    const window = relistenWindow({ start: 0.5, end: 1, kinds: ["gap"] }, words, 10, S);
    expect(window).toMatchObject({ first: 0, last: 2, from: 0.25 });
  });

  it("cuts the window's audio to a 16 kHz mono WAV", () => {
    expect(
      windowArgs("/job/converted.mp4", { first: 0, last: 1, from: 1.7, to: 3.55 }, "/job/w.wav"),
    ).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-ss",
      "1.700",
      "-to",
      "3.550",
      "-i",
      "/job/converted.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "/job/w.wav",
    ]);
  });
});

describe("heardTexts", () => {
  it("reads the texts of HyperFrames' word list, empty ones dropped", () => {
    expect(
      heardTexts([{ text: " Warm", start: 0, end: 1 }, { text: " " }, { text: "meals" }]),
    ).toEqual(["Warm", "meals"]);
    expect(heardTexts([])).toEqual([]);
    expect(() => heardTexts({})).toThrow(/not a word list/);
  });
});

describe("mergeHeard", () => {
  const window = relistenWindow(REEL_SPOT, REEL, 113.15, S);
  const merge = (heard: string) =>
    mergeHeard({ words: REEL, window, spot: REEL_SPOT, heard: heard.split(" ") });
  const textsAfter = (heard: string) => {
    const replacement = merge(heard);
    return (
      replacement &&
      applyReplacements(REEL, [replacement])
        .map((word) => word.text)
        .join(" ")
    );
  };

  it("replaces only the words between a matching old word on both sides of the spot", () => {
    const replacement = merge(
      "we are together? Warm meals made from local produce and hugs instead of",
    );
    // Only "And" (index 4) is replaced; the anchors "together?" and "hugs" stay.
    expect(replacement).toMatchObject({ from: 4, to: 5 });
    expect(replacement!.texts).toHaveLength(7);
  });

  it("keeps the old words without a matching old word before the spot", () => {
    expect(merge("Warm meals made from local produce and hugs instead of")).toBeNull();
  });

  it("keeps the old words without a matching old word after the spot", () => {
    expect(merge("we are together? Warm meals made from local produce")).toBeNull();
  });

  it("keeps the old words when nothing was heard", () => {
    expect(mergeHeard({ words: REEL, window, spot: REEL_SPOT, heard: [] })).toBeNull();
  });

  it("changes nothing on a false alarm: the same words, written another way", () => {
    expect(merge("We are together and hugs, instead of")).toBeNull();
  });

  it("matches a word whatever its capitals, accents and punctuation", () => {
    expect(merge("WE are togéther Warm meals and Hugs instead of")).toMatchObject({
      from: 4,
      to: 5,
    });
  });

  it("keeps an old word outside the spot that the larger model only hears differently", () => {
    // "to" is stretched over the dropped "alternative ways"; medium also
    // mishears "earn", which the spot never put in doubt.
    const words = wordsOf(
      "has@0.32-0.42",
      "given@0.48-0.7",
      "us@0.8-0.88",
      "to@1.18-2.06",
      "earn@2.26-2.36",
      "and@2.66-2.74",
      "is@2.9-2.98",
    );
    const spot: Spot = { start: 1.18, end: 2.06, kinds: ["word"] };
    const replacement = mergeHeard({
      words,
      window: relistenWindow(spot, words, 10, S),
      spot,
      heard: "has given us alternative ways to earth and is".split(" "),
    });
    expect(
      applyReplacements(words, [replacement!])
        .map((word) => word.text)
        .join(" "),
    ).toBe("has given us alternative ways to earn and is");
  });

  it("takes the heard words for an old word inside the spot", () => {
    const words = wordsOf("we@0-0.2", "like@0.3-0.5", "worms@1-2.5", "too@4-4.3", "much@4.4-4.6");
    const spot: Spot = { start: 1, end: 2.5, kinds: ["word"] };
    const replacement = mergeHeard({
      words,
      window: relistenWindow(spot, words, 5, S),
      spot,
      heard: "we like warm meals too much".split(" "),
    });
    expect(replacement).toEqual({ from: 2, to: 3, texts: ["warm", "meals"] });
  });

  describe("the writing at the join", () => {
    it("keeps an old word's writing, and the sentence it started: the word before gets a full stop", () => {
      expect(
        textsAfter("we are together? Warm meals made from local produce and hugs instead of"),
      ).toBe(
        "when we are together? Warm meals made from local produce. And hugs instead of more things.",
      );
    });

    it("adds no full stop after a word that already ends in punctuation", () => {
      expect(textsAfter("we are together? Warm meals, and hugs instead of")).toBe(
        "when we are together? Warm meals, And hugs instead of more things.",
      );
    });

    it("gives a new word after a sentence end its capital", () => {
      expect(textsAfter("we are together warm meals and hugs instead of")).toBe(
        "when we are together? Warm meals. And hugs instead of more things.",
      );
    });

    it("leaves a new word in the middle of a sentence as heard, and adds no stop before a plain old word", () => {
      const words = wordsOf("we@0-0.2", "like@0.3-0.5", "and@1-2.5", "hugs@4-4.3", "too@4.4-4.6");
      const spot: Spot = { start: 1, end: 2.5, kinds: ["word"] };
      const replacement = mergeHeard({
        words,
        window: relistenWindow(spot, words, 5, S),
        spot,
        heard: "we like warm meals and hugs too".split(" "),
      });
      expect(
        applyReplacements(words, [replacement!])
          .map((word) => word.text)
          .join(" "),
      ).toBe("we like warm meals and hugs too");
    });

    it("ends the new words with a full stop when the old word after them started a sentence", () => {
      const words = wordsOf("Go@0-0.2", "home.@0.3-0.6", "Then@3-3.2", "rest.@3.3-3.6");
      const spot: Spot = { start: 1, end: 2, kinds: ["gap"] };
      const replacement = mergeHeard({
        words,
        window: relistenWindow(spot, words, 4, S),
        spot,
        heard: "go home eat well then rest".split(" "),
      });
      expect(
        applyReplacements(words, [replacement!])
          .map((word) => word.text)
          .join(" "),
      ).toBe("Go home. Eat well. Then rest.");
    });
  });
});

describe("applyReplacements and the ids", () => {
  it("numbers the final list by position: every word after the new ones moves up", () => {
    const merged = numberWords(
      applyReplacements(REEL, [{ from: 4, to: 5, texts: ["Warm", "meals", "And"] }]),
    );
    expect(merged.map((word) => `${word.id} ${word.text}`)).toEqual([
      "w0001 when",
      "w0002 we",
      "w0003 are",
      "w0004 together?",
      "w0005 Warm",
      "w0006 meals",
      "w0007 And",
      "w0008 hugs",
      "w0009 instead",
      "w0010 of",
      "w0011 more",
      "w0012 things.",
    ]);
  });

  it("spreads the new words between the words around them, for the aligner to place", () => {
    const merged = applyReplacements(REEL, [{ from: 4, to: 5, texts: ["Warm", "meals", "And"] }]);
    expect(merged.slice(4, 7)).toEqual([
      { text: "Warm", start: 97.22, end: 101.233 },
      { text: "meals", start: 101.233, end: 105.247 },
      { text: "And", start: 105.247, end: 109.26 },
    ]);
    expect(merged[0]).toEqual({ text: "when", start: 96.3, end: 96.42 });
  });

  it("makes several replacements, and drops one that overlaps an earlier one", () => {
    const merged = applyReplacements(REEL, [
      { from: 6, to: 8, texts: ["rather", "than"] },
      { from: 1, to: 2, texts: ["they"] },
      { from: 7, to: 9, texts: ["never"] },
    ]);
    expect(merged.map((word) => word.text).join(" ")).toBe(
      "when they are together? And hugs rather than more things.",
    );
  });

  it("can only remove words between two anchors", () => {
    const merged = applyReplacements(REEL, [{ from: 4, to: 5, texts: [] }]);
    expect(merged.map((word) => word.text).join(" ")).toBe(
      "when we are together? hugs instead of more things.",
    );
  });
});

describe("relistenSummary", () => {
  it("says nothing without a spot, so the step line is as before", () => {
    expect(relistenSummary(0, 89, 89, false)).toBe("");
  });

  it("names the spots heard again and what they did to the word count", () => {
    expect(relistenSummary(1, 89, 95, true)).toBe(", 1 spot re-listened, 6 words added");
    expect(relistenSummary(2, 89, 90, true)).toBe(", 2 spots re-listened, 1 word added");
    expect(relistenSummary(1, 89, 88, true)).toBe(", 1 spot re-listened, 1 word removed");
    expect(relistenSummary(1, 89, 89, true)).toBe(", 1 spot re-listened, words changed");
    expect(relistenSummary(3, 89, 89, false)).toBe(", 3 spots re-listened, no change");
  });
});
