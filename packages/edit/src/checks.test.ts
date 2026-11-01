import { beforeAll, describe, expect, it } from "vitest";
import { build } from "./build.ts";
import type { Measurer } from "./measure.ts";
import { ISSEBYA } from "./preset.ts";
import type { HeadTrack, Transcript } from "./transcript.ts";
import { type Fixture, fixtures, nodeMeasurer } from "./testdata/node.ts";

let measurer: Measurer;
let all: Fixture[];

beforeAll(async () => {
  measurer = await nodeMeasurer();
  all = await fixtures();
});

const INPUTS = {
  footage: "1".repeat(64),
  transcript: "2".repeat(64),
  cutout: "3".repeat(64),
  headTrack: "4".repeat(64),
};

const transcript: Transcript = {
  words: [
    { id: "w0001", text: "one", start: 0, end: 0.5 },
    { id: "w0002", text: "two", start: 0.5, end: 1 },
    { id: "w0003", text: "three", start: 1, end: 1.5 },
  ],
};

// A head in the middle of the frame for the whole clip: face box x 357 to
// 732, y 500 to 920.
const head: HeadTrack = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5].map((t) => ({
  t,
  head_top: 500,
  cx: 540,
  head_w: 310,
}));

function edit(tracks: Record<string, unknown[]>) {
  return {
    format: 1,
    inputs: INPUTS,
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

const checksOf = (tracks: Record<string, unknown[]>, headTrack: HeadTrack = head) =>
  build({ edit: edit(tracks), transcript, headTrack, preset: ISSEBYA, measurer }).checks;

describe("runChecks", () => {
  it("fails safe-box for a 40-character word at 110 px", () => {
    const checks = checksOf({
      overlays: [
        {
          id: "long",
          start: { word: "w0001" },
          end: { word: "w0002" },
          text: "a".repeat(40),
          style: { size: 110, position: { x: 140, y: 400 } },
        },
      ],
    });
    expect(checks).toEqual({ ok: false, reasons: ["long: outside the safe box (right)"] });
  });

  it("fails face for a caption placed inside the face box", () => {
    const checks = checksOf({
      captions: [
        {
          id: "cover",
          start: { word: "w0001" },
          end: { word: "w0001" },
          text: "hi",
          style: { position: { x: 500, y: 700 } },
        },
      ],
    });
    expect(checks).toEqual({ ok: false, reasons: ["cover: covers the face"] });
  });

  it("places captions beside the face when they have no position", () => {
    const checks = checksOf({
      captions: transcript.words.map((word) => ({
        id: `c-${word.id}`,
        start: { word: word.id },
        end: { word: word.id },
        text: word.text,
      })),
    });
    expect(checks).toEqual({ ok: true, reasons: [] });
  });

  it("fails sound-gap for two clicks 0.2 s apart and allows 0.25 s", () => {
    const click = (id: string, offset: number) => ({
      id,
      sound: "click",
      start: { word: "w0002", offset },
      end: { word: "w0002", offset: offset + 0.2 },
    });
    expect(checksOf({ sounds: [click("s1", 0), click("s2", 0.2)] })).toEqual({
      ok: false,
      reasons: ["s2: within 0.25 s of s1"],
    });
    expect(checksOf({ sounds: [click("s1", 0), click("s2", 0.25)] }).ok).toBe(true);
    expect(checksOf({ sounds: [click("s1", 0), click("s2", 0.249)] }).ok).toBe(false);
  });

  it("passes the short-speech and rethink-work baselines", () => {
    for (const name of ["short-speech-baseline", "rethink-work-baseline"]) {
      const fixture = all.find((entry) => entry.name === name)!;
      expect(build({ ...fixture, preset: ISSEBYA, measurer }).checks, name).toEqual({
        ok: true,
        reasons: [],
      });
    }
  });

  it("falls back to the low centred line with no head, and the face check passes", () => {
    const checks = checksOf(
      { captions: [{ id: "c1", start: { word: "w0001" }, end: { word: "w0001" }, text: "one" }] },
      [null, null],
    );
    expect(checks.ok).toBe(true);
  });
});
