import { ISSEBYA_PRESET, type Transcript, parseEdit, sentenceSpans } from "@edit-issebya/edit";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideInput, presetSummary } from "./input.ts";

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
  it("gives the transition library with what each kind is for and how often, never a card", () => {
    expect(presetSummary(ISSEBYA_PRESET)).toMatchObject({
      transitions: [
        { kind: "dim", description: ISSEBYA_PRESET.transitions.dim.description },
        { kind: "panel", description: ISSEBYA_PRESET.transitions.panel.description },
        { kind: "numbered", description: ISSEBYA_PRESET.transitions.numbered.description },
      ],
      transition_every_seconds: 7,
    });
    expect(JSON.stringify(presetSummary(ISSEBYA_PRESET))).not.toMatch(/card|#|rgb/);
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
      request: null,
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

describe("decideInput library", () => {
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
  const library = [
    { id: "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c", description: "a kitchen", tags: [] },
  ];
  const inputWith = (photos: boolean, request: string | null) =>
    decideInput({
      current: parsed.edit,
      transcript: real,
      preset: ISSEBYA_PRESET,
      library,
      forbid: { photos, bigWord: false },
      request,
    });

  it("is emptied only when photos are forbidden and there is no request", () => {
    expect(inputWith(true, null).library).toEqual([]);
    expect(inputWith(true, "photos again please").library).toHaveLength(1);
    expect(inputWith(false, null).library).toHaveLength(1);
    expect(inputWith(true, null).behind_rules).toEqual({
      photos_forbidden: true,
      big_word_forbidden: false,
    });
  });
});
