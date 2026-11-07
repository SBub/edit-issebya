import { ISSEBYA_PRESET, type Transcript, parseEdit, sentenceSpans } from "@edit-issebya/edit";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentChoices, decideInput, presetSummary } from "./input.ts";

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

describe("presetSummary", () => {
  it("gives the one transition kind a new answer may pick (numbered, the list) and what it is for", () => {
    expect(presetSummary(ISSEBYA_PRESET)).toMatchObject({
      transitions: [
        { kind: "numbered", description: ISSEBYA_PRESET.transitions.numbered.description },
      ],
    });
    expect(JSON.stringify(presetSummary(ISSEBYA_PRESET))).not.toMatch(/card|panel|#|rgb|"dim"/);
  });

  it("gives no pace, no rate and no per-reel count: the layout engine owns how often things show", () => {
    const summary = presetSummary(ISSEBYA_PRESET);
    expect(summary).not.toHaveProperty("transition_every_seconds");
    expect(summary).not.toHaveProperty("extra_every_seconds");
    expect(summary).not.toHaveProperty("behind");
    expect(JSON.stringify(summary)).not.toMatch(/seconds|pace|\d\s*s\b/);
  });
});

describe("decideInput sentences", () => {
  it("gives each sentence its word ids and words, no times", () => {
    const input = decideInput({
      current: {
        format: 1,
        preset: ISSEBYA_PRESET.id,
        duration: 3.2,
        inputs: {} as never,
        tracks: { footage: [], captions: [], overlays: [], transitions: [], sounds: [] },
      },
      transcript,
      preset: ISSEBYA_PRESET,
      hook: { text: "Hi" },
    });
    expect(input.sentences).toEqual([
      { from: "w1", to: "w2", text: "photos help" },
      { from: "w3", to: "w4", text: "do they" },
      { from: "w5", to: "w5", text: "yes" },
      { from: "w6", to: "w6", text: "always" },
    ]);
    expect(input.transcript[0]).toEqual({ id: "w1", text: "Photos" });
  });
});

describe("decideInput", () => {
  const read = (path: string): unknown =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const real = read("../../../../fixtures/pipeline/retime/transcript.json") as Transcript;
  const parsed = parseEdit(
    read("../../../../packages/edit/src/testdata/versions/baseline-short-speech.edit.json"),
    ISSEBYA_PRESET,
    real,
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  const input = (photos: boolean) =>
    decideInput({
      current: parsed.edit,
      transcript: real,
      preset: ISSEBYA_PRESET,
      forbid: { photos, bigWord: false },
      hook: { text: "Hi" },
    });

  it("gives the behind rules as data and no photo library: the components never see one", () => {
    expect(input(true).behind_rules).toEqual({
      photos_forbidden: true,
      big_word_forbidden: false,
    });
    expect(input(false)).not.toHaveProperty("library");
  });
});

describe("currentChoices", () => {
  it("shows an older title as a plain accent and leaves out a transition of another kind", () => {
    const shown = currentChoices({
      accents: [{ from: "w1", to: "w2", title: true, wish: "top" }],
      big_words: [{ word: "w3", wish: "big" }],
      visuals: [{ from: "w4", to: "w5", description: "a messy desk" }],
      transitions: [
        { kind: "dim", from: "w6", to: "w7", key_from: "w6", wish: "slow" },
        { kind: "numbered", from: "w8", to: "w9", key_from: "w8" },
      ],
      word_fixes: [],
      hook: { text: "Hi" },
    });
    // The hook is not a choice of the components: it is never shown as one.
    expect(shown).toEqual({
      accents: [{ from: "w1", to: "w2" }],
      big_words: [{ word: "w3" }],
      visuals: [{ from: "w4", to: "w5", description: "a messy desk" }],
      transitions: [{ kind: "numbered", from: "w8", to: "w9", key_from: "w8" }],
      word_fixes: [],
    });
  });
});
