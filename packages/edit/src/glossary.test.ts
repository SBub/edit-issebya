import { describe, expect, it } from "vitest";
import { glossaryCheck } from "./glossary.ts";
import { ISSEBYA } from "./preset.ts";
import type { Edit } from "./schema.ts";

function withCaption(text: string): Edit {
  return {
    format: 1,
    inputs: {
      footage: "1".repeat(64),
      transcript: "2".repeat(64),
      cutout: "3".repeat(64),
      headTrack: "4".repeat(64),
    },
    tracks: {
      footage: [],
      cutout: [],
      captions: [{ id: "c-w0007", start: { word: "w0007" }, end: { word: "w0007" }, text }],
      overlays: [],
      transitions: [],
      sounds: [],
    },
  };
}

describe("glossaryCheck", () => {
  it("fails a glossary word still shown as heard, in any case", () => {
    expect(glossaryCheck(withCaption("Locking"), ISSEBYA)).toEqual({
      ok: false,
      reasons: ['c-w0007: glossary: "Locking" should be "lock-in"'],
    });
  });

  it("passes the term itself", () => {
    expect(glossaryCheck(withCaption("lock-in"), ISSEBYA)).toEqual({ ok: true, reasons: [] });
  });

  it("passes a word that only contains the heard one", () => {
    expect(glossaryCheck(withCaption("blocking"), ISSEBYA)).toEqual({ ok: true, reasons: [] });
  });

  it("reads overlays and transition text too", () => {
    const edit = withCaption("fine");
    edit.tracks.overlays.push({
      id: "title",
      start: { at: 0 },
      end: { at: 1 },
      text: "no locking",
    });
    edit.tracks.transitions.push({
      id: "t1",
      start: { at: 1 },
      end: { at: 2 },
      type: "dim",
      text: "LOCKING in",
    });
    expect(glossaryCheck(edit, ISSEBYA).reasons).toEqual([
      't1: glossary: "LOCKING" should be "lock-in"',
      'title: glossary: "locking" should be "lock-in"',
    ]);
  });
});
