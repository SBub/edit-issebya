import { describe, expect, it } from "vitest";
import { glossaryChecks } from "./glossary.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

const transcript: Transcript = {
  words: [
    { id: "w0", text: "Locking", start: 0, end: 0.4 },
    { id: "w1", text: "lock", start: 0.5, end: 0.7 },
    { id: "w2", text: "in.", start: 0.7, end: 0.9 },
  ],
};

function edit(tracks: Partial<Edit["tracks"]>): Edit {
  return {
    format: 1,
    preset: "issebya",
    duration: 1,
    inputs: {
      footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
      transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
      cutout: { step: "remove_background", fingerprint: "r", file: "subject.webm" },
      head_track: { step: "head_track", fingerprint: "h", file: "head-track.json" },
    },
    tracks: {
      footage: [],
      cutout: [],
      captions: [],
      overlays: [],
      transitions: [],
      sounds: [],
      ...tracks,
    },
  };
}

const span = { start: { word: "w0" }, end: { word: "w0", edge: "end" as const } };

describe("glossaryChecks", () => {
  it("fails a caption showing a heard form", () => {
    const checks = glossaryChecks(
      edit({ captions: [{ id: "cw0003", ...span, words: ["w0"], text: "Locking" }] }),
      transcript,
      ISSEBYA_PRESET,
    );
    expect(checks).toEqual([
      {
        rule: "glossary",
        item: "cw0003",
        reason: 'caption cw0003 shows "Locking": write the glossary term "lock-in"',
      },
    ]);
  });

  it("passes the term itself", () => {
    expect(
      glossaryChecks(
        edit({ captions: [{ id: "cw0", ...span, words: ["w0"], text: "lock-in" }] }),
        transcript,
        ISSEBYA_PRESET,
      ),
    ).toEqual([]);
  });

  it("passes a caption without text over the heard words: the default text is the term", () => {
    expect(
      glossaryChecks(
        edit({ captions: [{ id: "cw1", ...span, words: ["w1", "w2"] }] }),
        transcript,
        ISSEBYA_PRESET,
      ),
    ).toEqual([]);
  });

  it("fails an accent overlay showing a heard form", () => {
    const checks = glossaryChecks(
      edit({ overlays: [{ id: "accent-a", ...span, kind: "accent", text: "lock in" }] }),
      transcript,
      ISSEBYA_PRESET,
    );
    expect(checks.map((check) => [check.rule, check.item])).toEqual([["glossary", "accent-a"]]);
  });
});
