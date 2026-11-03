import { describe, expect, it } from "vitest";
import { editFromAnswer } from "./decide.ts";
import { type EngineInput, choicesOf, placeDirect } from "./engine-input.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { resolveTimeline } from "./timeline.ts";

const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;
const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

const PHOTO = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";

const NOTHING: EngineInput = {
  accents: [],
  big_word: null,
  photos: [],
  transitions: [],
  word_fixes: [],
};

describe("placeDirect", () => {
  it("places nothing new over version 1: the same tracks", () => {
    const tracks = placeDirect(short.edit, NOTHING, short.transcript, [], ISSEBYA_PRESET);
    expect(tracks).toEqual(short.edit.tracks);
  });

  it("maps word ranges to items anchored on their words, and applies the fixes", () => {
    const tracks = placeDirect(
      short.edit,
      {
        ...NOTHING,
        accents: [
          { from: "w0001", to: "w0004", title: true },
          { from: "w0005", to: "w0005", title: false, wish: "big" },
        ],
        transitions: [{ kind: "dim", from: "w0006", to: "w0008" }],
        word_fixes: [{ word: "w0010", text: "Studio" }],
      },
      short.transcript,
      [],
      ISSEBYA_PRESET,
    );
    expect(tracks.overlays).toEqual([
      {
        id: "title",
        kind: "accent",
        start: { word: "w0001" },
        end: { word: "w0004", edge: "end" },
        words: ["w0001", "w0002", "w0003", "w0004"],
      },
      {
        id: "accent-1",
        kind: "accent",
        start: { word: "w0005" },
        end: { word: "w0005", edge: "end" },
        words: ["w0005"],
      },
    ]);
    expect(tracks.transitions).toEqual([
      {
        id: "transition-1",
        type: "dim",
        start: { word: "w0006" },
        end: { word: "w0008", edge: "end" },
      },
    ]);
    expect(tracks.captions.find((caption) => caption.id === "cw0010")!.text).toBe("Studio");
    expect(tracks.captions.filter((caption) => caption.text !== undefined)).toHaveLength(1);
  });

  it("holds a photo to 2 to 4 seconds from its first word, ending on a word edge", () => {
    const { transcript } = hand;
    const words = transcript.words;
    // A one-word photo (too short) and a long sentence (too long).
    const shortPhoto = { photo_id: PHOTO, from: words[10]!.id, to: words[10]!.id };
    const longFrom = words.findIndex((word) => word.start > 20);
    const longTo = words.findIndex((word) => word.end > words[longFrom]!.start + 8);
    const longPhoto = { photo_id: PHOTO, from: words[longFrom]!.id, to: words[longTo]!.id };
    for (const [photo, expected] of [
      [shortPhoto, 2],
      [longPhoto, 4],
    ] as const) {
      const tracks = placeDirect(
        hand.edit,
        { ...NOTHING, photos: [photo] },
        transcript,
        hand.headTrack,
        ISSEBYA_PRESET,
      );
      const edit = { ...hand.edit, tracks };
      const span = resolveTimeline(edit, transcript).get("photo-1")!;
      const first = words.find((word) => word.id === photo.from)!;
      expect(span.start).toBe(first.start);
      expect(span.end - span.start).toBeCloseTo(expected, 3);
      expect(tracks.behind![0]!.end).toHaveProperty("word");
    }
  });

  it("ends the big word at the end of its sentence, within 2 to 4 seconds", () => {
    const tracks = placeDirect(
      short.edit,
      { ...NOTHING, big_word: { word: "w0001" } },
      short.transcript,
      [],
      ISSEBYA_PRESET,
    );
    expect(tracks.behind).toEqual([
      {
        id: "big-word",
        kind: "word",
        text: "this",
        start: { word: "w0001" },
        end: { word: "w0010", edge: "end" },
      },
    ]);
  });

  it("puts a photo in its wished spot, else the first spot the face leaves clear", () => {
    const photo = { photo_id: PHOTO, from: "w0001", to: "w0010" };
    const spot = (input: EngineInput, headTrack = short.headTrack) => {
      const item = placeDirect(short.edit, input, short.transcript, headTrack, ISSEBYA_PRESET)
        .behind![0]!;
      return item.kind === "photo" ? item.spot : null;
    };
    expect(spot({ ...NOTHING, photos: [photo] })).toBe("top");
    expect(spot({ ...NOTHING, photos: [{ ...photo, wish: "left" }] })).toBe("left");
    // A head 300 px wide in the left spot: the wish gives way to a clear spot.
    const head = Array.from({ length: 12 }, (_, index) => ({
      t: index * 0.25,
      head_top: 600,
      cx: 270,
      head_w: 300,
    }));
    expect(spot({ ...NOTHING, photos: [{ ...photo, wish: "left" }] }, head)).toBe("top");
    // A head as wide as the frame takes every spot: the first one stays, and
    // the behind-face check refuses it.
    const wide = head.map((sample) => ({ ...sample, head_top: 100, cx: 540, head_w: 900 }));
    expect(spot({ ...NOTHING, photos: [photo] }, wide)).toBe("top");
  });

  it("keeps an unchanged photo in the spot it had", () => {
    const choices = choicesOf(behind.edit, behind.transcript, ISSEBYA_PRESET);
    const tracks = placeDirect(
      behind.edit,
      { ...choices, big_word: null },
      behind.transcript,
      behind.headTrack,
      ISSEBYA_PRESET,
    );
    expect(tracks.behind![0]).toMatchObject({ kind: "photo", spot: "right" });
  });
});

describe("choicesOf", () => {
  it("reads a stored version back as choices by words", () => {
    const choices = choicesOf(behind.edit, behind.transcript, ISSEBYA_PRESET);
    expect(choices.photos).toEqual([
      { photo_id: "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14", from: "w18", to: "w27" },
    ]);
    // "WORK" is not spoken under it: the first word under it stands in.
    expect(choices.big_word).toEqual({ word: "w76" });
    expect(choices.accents.map((accent) => accent.from)).toEqual(["w29", "w112"]);
    expect(choices.transitions).toEqual([{ kind: "panel", from: "w126", to: "w133" }]);
    expect(choices.word_fixes).toEqual([
      { word: "w89", text: "Gen Z" },
      { word: "w161", text: "want?" },
    ]);
  });

  it("reads a written title as the words spoken under it", () => {
    const edit = structuredClone(short.edit);
    edit.tracks.overlays.push({
      id: "title",
      kind: "accent",
      start: { reel: "start" },
      end: { word: "w0004", edge: "end" },
      text: "A short test",
    });
    expect(choicesOf(edit, short.transcript, ISSEBYA_PRESET).accents).toEqual([
      { from: "w0001", to: "w0004", title: true },
    ]);
  });

  it("round-trips: the choices placed again pass as an edit", () => {
    for (const fixture of [hand, behind]) {
      const choices = choicesOf(fixture.edit, fixture.transcript, ISSEBYA_PRESET);
      const made = editFromAnswer(
        fixture.edit,
        choices,
        ISSEBYA_PRESET,
        fixture.transcript,
        fixture.headTrack,
      );
      if (!made.ok) throw new Error(`${fixture.name}: ${made.reasons.join("; ")}`);
      expect(choicesOf(made.edit, fixture.transcript, ISSEBYA_PRESET)).toEqual(choices);
    }
  });
});
