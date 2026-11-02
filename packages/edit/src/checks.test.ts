import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import type { HeadTrack } from "./head-track.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

async function checksOf(edit: Edit, headTrack: HeadTrack = hand.headTrack) {
  return build(edit, hand.transcript, headTrack, ISSEBYA_PRESET, await nodeMeasurer()).checks;
}

describe("runChecks", () => {
  it("passes the stored fixture versions (an empty list)", async () => {
    for (const fixture of FIXTURES) {
      const { checks } = build(
        fixture.edit,
        fixture.transcript,
        fixture.headTrack,
        ISSEBYA_PRESET,
        await nodeMeasurer(),
      );
      expect(checks).toEqual([]);
    }
  });

  it("fails safe-box for a 40-character word as an accent at 110 px", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.overlays[0]!.text = "a".repeat(40);
    const checks = await checksOf(edit);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ rule: "safe-box", item: "aw29" });
    expect(checks[0]!.reason).toMatch(
      /^accent aw29 \("a{40}"\) runs past the safe box: left edge -?\d+ < 130, right edge \d+ > 860$/,
    );
  });

  it("fails face for a caption set over the head", async () => {
    const head: HeadTrack = Array.from({ length: 200 }, (_, index) => ({
      t: index * 0.25,
      head_top: 500,
      cx: 540,
      head_w: 300,
    }));
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.position = { x: 540, y: 700, align: "center" };
    const checks = await checksOf(edit, head);
    expect(checks.filter((check) => check.rule === "face").map((check) => check.item)).toEqual([
      "cw0",
    ]);
  });

  it("fails sound-gap for two clicks 0.2 s apart", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.sounds.push({
      id: "s-second",
      sound: "click",
      start: { word: "w126", offset: 0.17 },
      end: { word: "w126", offset: 0.4 },
    });
    expect(await checksOf(edit)).toEqual([
      {
        rule: "sound-gap",
        item: "s-second",
        reason: "sound s-second is 0.200 s after s-fund-life, under 0.25 s",
      },
    ]);
  });

  it("fails time-in-speech for a time anchor inside a word", async () => {
    const word = hand.transcript.words[5]!;
    const middle = Math.round(((word.start + word.end) / 2) * 1000) / 1000;
    const edit = structuredClone(hand.edit);
    edit.tracks.sounds[0]!.start = { time: middle };
    edit.tracks.sounds[0]!.end = { word: word.id, edge: "end" };
    const checks = await checksOf(edit);
    expect(checks.map((check) => [check.rule, check.item])).toEqual([
      ["time-in-speech", "s-fund-life"],
    ]);
    expect(checks[0]!.reason).toContain(`inside the word ${word.id}`);
  });
});
