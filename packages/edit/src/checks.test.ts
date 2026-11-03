import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import type { HeadTrack } from "./head-track.ts";
import { ISSEBYA_PRESET, PLATFORM_BUTTONS } from "./preset.ts";
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

  it("fails safe-box for a caption set at y 1380", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.position = { x: 540, y: 1380, align: "center" };
    const checks = (await checksOf(edit)).filter((check) => check.rule === "safe-box");
    expect(checks.map((check) => check.item)).toEqual(["cw0"]);
    expect(checks[0]!.reason).toMatch(/runs past the safe box: bottom edge 1430 > 1400$/);
  });

  // A preset whose box is the whole frame: only the platform guard holds.
  const loose = { ...ISSEBYA_PRESET, safe: { left: 0, right: 1080, top: 0, bottom: 1920 } };
  async function looseSafeBox(position: { x: number; y: number; align: "right" }) {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.position = position;
    const { checks } = build(edit, hand.transcript, hand.headTrack, loose, await nodeMeasurer());
    // The looser box also lets the layout set other text past the guard;
    // only the moved caption is looked at.
    return checks.filter((check) => check.rule === "safe-box" && check.item === "cw0");
  }

  it("checks against the platform guard under a preset with a looser box", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.position = { x: 540, y: 1450, align: "center" };
    const { checks } = build(edit, hand.transcript, hand.headTrack, loose, await nodeMeasurer());
    const cw0 = checks.find((check) => check.rule === "safe-box" && check.item === "cw0");
    expect(cw0?.reason).toMatch(/runs past the safe box: bottom edge 1500 > 1470$/);
  });

  it("fails safe-box for text in the button column's notch, passes it higher up", async () => {
    // Right-aligned to the guard's right edge: inside the outer box either way.
    const low = await looseSafeBox({ x: 1040, y: PLATFORM_BUTTONS.top + 40, align: "right" });
    expect(low).toHaveLength(1);
    expect(low[0]!.reason).toMatch(
      /runs into the platform button column below y 1164: right edge 1040 > 945$/,
    );
    expect(await looseSafeBox({ x: 1040, y: PLATFORM_BUTTONS.top - 100, align: "right" })).toEqual(
      [],
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

describe("runChecks on big words behind the speaker", () => {
  const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;

  it("skips the safe box for a big word (it crosses the frame by design)", async () => {
    const { checks, html } = build(
      behind.edit,
      behind.transcript,
      behind.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain('id="behind-word"');
    expect(checks).toEqual([]);
  });

  it("fails frame for a big word pushed above the frame by a head at its top edge", async () => {
    const atTop = behind.headTrack.map((sample) => sample && { ...sample, head_top: 0 });
    const { checks } = build(
      behind.edit,
      behind.transcript,
      atTop,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    const frame = checks.filter((check) => check.rule === "frame");
    expect(frame.map((check) => check.item)).toEqual(["behind-word"]);
    expect(frame[0]!.reason).toMatch(
      /^big word behind-word \("WORK"\) leaves the frame: top edge -\d+ < 0$/,
    );
  });
});

describe("runChecks on photos behind the speaker", () => {
  const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;

  async function behindChecks(spot: "top" | "left" | "right", headTrack: HeadTrack) {
    const edit = structuredClone(behind.edit);
    const photo = edit.tracks.behind!.find((item) => item.kind === "photo")!;
    if (photo.kind === "photo") photo.spot = spot;
    const { checks } = build(
      edit,
      behind.transcript,
      headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    return checks.filter((check) => check.rule.startsWith("behind-"));
  }

  // A head 300 px wide centred in the left spot: its face box (300 by 405 px)
  // lies wholly inside the spot and covers 43% of it.
  const bigHeadLeft: HeadTrack = behind.headTrack.map(
    (sample, index) => sample && { t: index * 0.25, head_top: 600, cx: 270, head_w: 300 },
  );

  it("fails behind-face for a photo in left over a face inside the spot", async () => {
    const checks = await behindChecks("left", bigHeadLeft);
    const face = checks.filter((check) => check.rule === "behind-face");
    expect(face).toHaveLength(1);
    expect(face[0]).toMatchObject({ item: "behind-photo" });
    expect(face[0]!.reason).toBe(
      "photo behind-photo in the left spot: the face covers 43% of it, more than 40%; pick a spot clear of the head",
    );
  });

  it("passes behind-face for the same photo with no head in the clip", async () => {
    const empty: HeadTrack = behind.headTrack.map(() => null);
    const checks = await behindChecks("left", empty);
    expect(checks.filter((check) => check.rule === "behind-face")).toEqual([]);
  });

  it("fails behind-caption for a photo in top under the captions shown with it", async () => {
    const checks = await behindChecks("top", behind.headTrack);
    expect(checks.every((check) => check.rule === "behind-caption")).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]!.item).toBe("behind-photo");
    expect(checks[0]!.reason).toMatch(
      /^photo behind-photo in the top spot sits under caption cw\d+ \(".+"\); pick another spot$/,
    );
    expect(checks.map((check) => check.reason).join("\n")).toContain("caption cw18 ");
  });

  it("passes both for the stored fixture's photo in right", async () => {
    expect(await behindChecks("right", behind.headTrack)).toEqual([]);
  });
});
