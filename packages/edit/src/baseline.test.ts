import { describe, expect, it } from "vitest";
import { baselineEdit } from "./baseline.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { SHORT_SPEECH, baselineInputs } from "./test-support/inputs.ts";
import type { Transcript } from "./transcript.ts";

function words(...texts: string[]): Transcript {
  return {
    words: texts.map((text, index) => ({
      id: `w${index + 1}`,
      text,
      start: index * 0.3,
      end: index * 0.3 + 0.25,
    })),
  };
}

function captions(transcript: Transcript) {
  return baselineEdit(transcript, baselineInputs(), ISSEBYA_PRESET).tracks.captions;
}

describe("baselineEdit", () => {
  it("is the stored baseline of the fixture clip", () => {
    const stored = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;
    expect(baselineEdit(SHORT_SPEECH.transcript, baselineInputs(), ISSEBYA_PRESET)).toEqual(
      stored.edit,
    );
  });

  it("has one caption per word, ending with its group, and nothing else", () => {
    const edit = baselineEdit(SHORT_SPEECH.transcript, baselineInputs(), ISSEBYA_PRESET);
    expect(edit.tracks.captions).toHaveLength(SHORT_SPEECH.transcript.words.length);
    expect(edit.tracks.captions[0]).toEqual({
      id: "cw0001",
      start: { word: "w0001" },
      end: { word: "w0004", edge: "end" },
      words: ["w0001"],
    });
    expect(edit.tracks.footage).toEqual([
      { id: "footage", start: { reel: "start" }, end: { reel: "end" } },
    ]);
    expect(edit.tracks.overlays).toEqual([]);
    expect(edit.tracks.transitions).toEqual([]);
    expect(edit.tracks.sounds).toEqual([]);
    expect(parseEdit(edit, ISSEBYA_PRESET, SHORT_SPEECH.transcript)).toMatchObject({ ok: true });
  });

  it("joins lock-in from 'Locking' and from 'lock' 'in'", () => {
    expect(captions(words("Locking", "is", "bad.")).map((caption) => caption.words)).toEqual([
      ["w1"],
      ["w2"],
      ["w3"],
    ]);
    expect(captions(words("The", "lock", "in.")).map((caption) => caption.words)).toEqual([
      ["w1"],
      ["w2", "w3"],
    ]);
  });

  it("joins a number with its unit and a month with its day", () => {
    expect(
      captions(words("about", "40", "hours", "since", "March", "5")).map((c) => c.words),
    ).toEqual([["w1"], ["w2", "w3"], ["w4"], ["w5", "w6"]]);
  });

  it("makes a valid version of an empty transcript: footage and cut-out only", () => {
    const edit = baselineEdit({ words: [] }, baselineInputs(), ISSEBYA_PRESET);
    expect(edit.tracks.captions).toEqual([]);
    expect(parseEdit(edit, ISSEBYA_PRESET, { words: [] })).toMatchObject({ ok: true });
  });
});
