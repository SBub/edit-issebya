import { describe, expect, it } from "vitest";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { diffEdits, ruleChanges } from "./version-diff.ts";

const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
const { transcript } = behind;
const PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";

function edit(change: (edit: Edit) => void = () => {}): Edit {
  const copy = structuredClone(behind.edit);
  change(copy);
  return copy;
}

const diff = (before: Edit, after: Edit) => diffEdits(before, after, transcript, ISSEBYA_PRESET);

describe("diffEdits", () => {
  it("gives nothing for identical edits", () => {
    expect(diff(edit(), edit())).toEqual([]);
  });

  it("finds a photo added and a photo removed, with its words", () => {
    const without = edit(
      (e) => (e.tracks.behind = e.tracks.behind!.filter((i) => i.kind !== "photo")),
    );
    const added = diff(without, edit());
    expect(added).toEqual([
      expect.objectContaining({
        kind: "photo",
        action: "added",
        id: "behind-photo",
        photo_id: PHOTO,
      }),
    ]);
    expect(added[0]!.text).toMatch(/\w/);
    expect(diff(edit(), without)).toEqual([
      expect.objectContaining({ kind: "photo", action: "removed", photo_id: PHOTO }),
    ]);
  });

  it("finds a photo whose spot changed as moved, with the spot from and to", () => {
    const moved = edit((e) => {
      const photo = e.tracks.behind!.find((i) => i.kind === "photo")!;
      if (photo.kind === "photo") photo.spot = "left";
    });
    expect(diff(edit(), moved)).toEqual([
      expect.objectContaining({
        kind: "photo",
        action: "moved",
        spot: { from: "right", to: "left" },
      }),
    ]);
  });

  it("reads an accent on new words as removed plus added", () => {
    const other = edit((e) => {
      const accent = e.tracks.overlays.find((i) => i.id === "aw112")!;
      accent.words = ["w113"];
      accent.start = { word: "w113" };
      accent.end = { word: "w113", edge: "end" };
    });
    const entries = diff(edit(), other);
    expect(entries.map((e) => `${e.kind} ${e.action}`).sort()).toEqual([
      "accent added",
      "accent removed",
    ]);
  });

  it("reads the same words with new anchors as retimed", () => {
    const later = edit((e) => {
      e.tracks.overlays.find((i) => i.id === "aw112")!.end = { word: "w114", edge: "end" };
    });
    expect(diff(edit(), later)).toEqual([
      expect.objectContaining({ kind: "accent", action: "retimed", id: "aw112" }),
    ]);
  });

  it("never reads renumbered ids with the same type and start word as a change", () => {
    const renumbered = edit((e) => {
      e.tracks.transitions[0]!.id = "transition-1";
    });
    expect(diff(edit(), renumbered)).toEqual([]);
  });

  it("reports a caption text fix as one changed entry with the new text", () => {
    const fixed = edit((e) => (e.tracks.captions[5]!.text = "Studio"));
    expect(diff(edit(), fixed)).toEqual([
      { kind: "caption", action: "changed", id: e5(), text: "Studio" },
    ]);
  });

  it("folds many captions shifted into one captions moved entry", () => {
    const shifted = edit((e) => {
      for (const caption of e.tracks.captions.slice(0, 40)) {
        caption.position = { x: 100, y: 900, align: "center" };
      }
    });
    expect(diff(edit(), shifted)).toEqual([{ kind: "caption", action: "moved", id: "captions" }]);
  });

  it("orders by kind and never puts a word id in a text", () => {
    const many = edit((e) => {
      e.tracks.behind = [];
      e.tracks.transitions = [];
      e.tracks.overlays.push({
        id: "title",
        kind: "accent",
        words: ["w0", "w1"],
        start: { word: "w0" },
        end: { word: "w1", edge: "end" },
      });
    });
    const entries = diff(edit(), many);
    expect(entries.map((e) => e.kind)).toEqual(["title", "photo", "big_word", "transition"]);
    for (const entry of entries) expect(entry.text ?? "").not.toMatch(/\bw\d+\b/);
    expect(diff(edit(), many)).toEqual(entries);
  });
});

function e5(): string {
  return behind.edit.tracks.captions[5]!.id;
}

describe("ruleChanges", () => {
  it("says off when a forbid is set and on when it is lifted", () => {
    const none = { photos: false, bigWord: false };
    expect(ruleChanges(none, none)).toEqual([]);
    expect(ruleChanges(none, { photos: true, bigWord: false })).toEqual([
      { rule: "photos", to: "off" },
    ]);
    expect(ruleChanges({ photos: true, bigWord: true }, { photos: true, bigWord: false })).toEqual([
      { rule: "big_word", to: "on" },
    ]);
  });
});
