import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { type HeadTrack, facesOver } from "./head-track.ts";
import { CLEAN_PRESET, PLATFORM_BUTTONS } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// The behind edit's choices placed by the layout engine: every check passes.
const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-engine")!;

async function checksOf(edit: Edit, headTrack: HeadTrack = hand.headTrack) {
  return build(edit, hand.transcript, headTrack, CLEAN_PRESET, await nodeMeasurer()).checks;
}

describe("runChecks", () => {
  it("passes the engine-placed fixture versions (an empty list)", async () => {
    for (const fixture of FIXTURES.filter(
      (f) => !f.name.endsWith("-hand") && !f.name.endsWith("-behind"),
    )) {
      const { checks } = build(
        fixture.edit,
        fixture.transcript,
        fixture.headTrack,
        CLEAN_PRESET,
        await nodeMeasurer(),
      );
      expect(checks).toEqual([]);
    }
  });

  it("finds the faults of the old fixed-spot placement in the hand-made versions", async () => {
    for (const name of ["rethink-work-hand", "rethink-work-behind"]) {
      const fixture = FIXTURES.find((f) => f.name === name)!;
      const { checks } = build(
        fixture.edit,
        fixture.transcript,
        fixture.headTrack,
        CLEAN_PRESET,
        await nodeMeasurer(),
      );
      // Captions over a moving head, a last word shown under 0.25 s, accents
      // under 1.5 s; and in the behind edit the big word on the captions,
      // shown before its word is said and mostly behind the head (today's
      // failures).
      const rules = new Set(checks.map((check) => check.rule));
      expect([...rules].sort()).toEqual(
        name === "rethink-work-hand"
          ? ["face", "timing"]
          : ["big-word-hidden", "big-word-timing", "face", "text-overlap", "timing"],
      );
    }
  });

  it("fails safe-box for a 40-character word as an accent at 110 px", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.overlays[0]!.text = "a".repeat(40);
    const checks = await checksOf(edit);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ rule: "safe-box", item: "accent-1" });
    expect(checks[0]!.reason).toMatch(
      /^accent accent-1 \("a{40}"\) runs past the safe box: right edge \d+ > 860$/,
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
  const loose = { ...CLEAN_PRESET, safe: { left: 0, right: 1080, top: 0, bottom: 1920 } };
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

  it("checks a transition's levels for the safe box and overlaps, never its hidden captions", async () => {
    const transitions = FIXTURES.find((f) => f.name === "rethink-work-transitions")!;
    const levelChecks = async (edit: Edit) =>
      build(edit, transitions.transcript, transitions.headTrack, CLEAN_PRESET, await nodeMeasurer())
        .checks;
    // Hidden captions with no place trip no timing, face or overlap check.
    expect(await levelChecks(transitions.edit)).toEqual([]);
    const low = structuredClone(transitions.edit);
    low.tracks.transitions[0]!.levels!.key.position.y = 1380;
    expect(
      (await levelChecks(low)).filter((check) => check.rule === "safe-box").map((c) => c.item),
    ).toEqual(["transition-1-key"]);
    // A caption set on a level shown at the same time.
    const over = structuredClone(transitions.edit);
    const key = over.tracks.transitions[0]!.levels!.key;
    const caption = over.tracks.captions.find((c) => c.id === "cw34")!;
    caption.position = { x: key.position.x, y: key.position.y, align: "center" };
    over.tracks.transitions[0]!.end = { word: "w36" };
    expect(
      (await levelChecks(over)).filter((check) => check.rule === "text-overlap"),
    ).toContainEqual({
      rule: "text-overlap",
      item: "transition-1-key",
      reason: expect.stringMatching(
        /^level transition-1-key \("the way we work"\) sits on caption cw34 /,
      ),
    });
  });

  it("fails sound-gap for two clicks 0.2 s apart", async () => {
    const edit = structuredClone(hand.edit);
    // The engine's click as visual 1 comes in (on w18), and a second one.
    edit.tracks.sounds.push({
      id: "s-second",
      sound: "click",
      start: { word: "w18", offset: 0.2 },
      end: { word: "w18", offset: 0.43 },
    });
    expect(await checksOf(edit)).toEqual([
      {
        rule: "sound-gap",
        item: "s-second",
        reason: "sound s-second is 0.200 s after click-visual-1, under 0.25 s",
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
      ["time-in-speech", "click-visual-1"],
    ]);
    expect(checks[0]!.reason).toContain(`inside the word ${word.id}`);
  });
});

describe("runChecks on big words behind the speaker", () => {
  const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;

  it("skips the safe box for a big word (it crosses the frame by design)", async () => {
    const { checks, html } = build(
      hand.edit,
      hand.transcript,
      hand.headTrack,
      CLEAN_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain('id="big-word-1"');
    expect(checks).toEqual([]);
  });

  it("fails text-overlap for a big word set on the captions, big-word-timing before its word", async () => {
    const edit = structuredClone(hand.edit);
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    // On the captions' line (behind the body too), and a word said only after
    // it shows.
    if (word.kind === "word") Object.assign(word, { position: { x: 42, y: 1000 }, text: "work" });
    const { checks } = build(
      edit,
      hand.transcript,
      hand.headTrack,
      CLEAN_PRESET,
      await nodeMeasurer(),
    );
    const rules = [...new Set(checks.map((check) => check.rule))];
    expect(rules).toEqual(["text-overlap", "big-word-timing", "big-word-hidden"]);
    expect(checks.find((check) => check.rule === "big-word-timing")!.reason).toMatch(
      /^big word big-word-1 \("work"\) shows at \d+\.\d{3} s, more than 0\.2 s before w95 is said at 24\.887 s$/,
    );
  });

  it("passes big-word-timing for a big word coming in the lead before its word", async () => {
    const word = hand.edit.tracks.behind!.find((item) => item.kind === "word")!;
    expect(word.start).toMatchObject({ offset: -CLEAN_PRESET.accent.leadSeconds });
    const checks = await checksOf(hand.edit);
    expect(checks.filter((check) => check.rule === "big-word-timing")).toEqual([]);
  });

  it("times a two-word big word from its first spoken word", async () => {
    const edit = structuredClone(hand.edit);
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    // "work" is said at w95, a second after this big word starts.
    if (word.kind === "word") Object.assign(word, { text: "work it" });
    const checks = await checksOf(edit);
    expect(checks.find((check) => check.rule === "big-word-timing")!.reason).toMatch(
      /^big word big-word-1 \("work it"\) shows at \d+\.\d{3} s, more than 0\.2 s before w95 is said at 24\.887 s$/,
    );
  });

  it("fails big-word-hidden for a big word set at head height, mostly behind the person", async () => {
    const edit = structuredClone(hand.edit);
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    if (word.kind !== "word") throw new Error("expected a big word");
    // A narrow, small word centred on the head: the head covers nearly all
    // of it (the old "centre below the head top" place of a short word).
    const said = hand.transcript.words.find((w) => w.id === (word.start as { word: string }).word)!;
    const face = facesOver(hand.headTrack, said.start, said.start)[0]!;
    Object.assign(word, {
      text: "all",
      size: 120,
      position: { x: Math.round((face.left + face.right) / 2 - 80), y: face.top + 20 },
    });
    const hidden = (await checksOf(edit)).filter((check) => check.rule === "big-word-hidden");
    expect(hidden.map((check) => check.item)).toEqual([word.id]);
    expect(hidden[0]!.reason).toMatch(
      /^big word big-word-1 \("all"\): the person covers \d+% of its height, more than 30%; move it up out from behind the head$/,
    );
  });

  it("passes big-word-hidden for the engine's big word, most of it in view", async () => {
    const checks = await checksOf(hand.edit);
    expect(checks.filter((check) => check.rule === "big-word-hidden")).toEqual([]);
  });

  it("fails frame for a big word pushed above the frame by a head at its top edge", async () => {
    const atTop = behind.headTrack.map((sample) => sample && { ...sample, head_top: 0 });
    const { checks } = build(
      behind.edit,
      behind.transcript,
      atTop,
      CLEAN_PRESET,
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
      CLEAN_PRESET,
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

  // The photo with a box the engine set, in front of or behind the speaker.
  async function boxChecks(
    layer: "front" | "behind",
    box: { x: number; y: number; width: number; height: number },
    headTrack: HeadTrack,
  ) {
    const edit = structuredClone(behind.edit);
    const photo = edit.tracks.behind!.find((item) => item.kind === "photo")!;
    if (photo.kind === "photo") Object.assign(photo, { layer, box });
    const { checks } = build(
      edit,
      behind.transcript,
      headTrack,
      CLEAN_PRESET,
      await nodeMeasurer(),
    );
    return checks.filter(
      (check) =>
        check.item === "behind-photo" &&
        (check.rule === "behind-face" || check.rule === "photo-hidden"),
    );
  }
  // A steady head: face box (padded) x 160 to 375, y 600 to 802.
  const steady: HeadTrack = behind.headTrack.map(
    (sample, index) => sample && { t: index * 0.25, head_top: 600, cx: 270, head_w: 150 },
  );

  it("fails behind-face for a photo in front over any part of the face", async () => {
    const over = await boxChecks("front", { x: 300, y: 700, width: 300, height: 200 }, steady);
    expect(over).toEqual([
      {
        rule: "behind-face",
        item: "behind-photo",
        reason: "photo behind-photo in front covers the face; a photo in front stays clear of it",
      },
    ]);
    // Beside the face, over the body, is fine in front.
    expect(await boxChecks("front", { x: 600, y: 300, width: 300, height: 200 }, steady)).toEqual(
      [],
    );
  });

  it("fails photo-hidden for a photo behind the speaker the person covers over 30% of", async () => {
    // Its lower half behind the head.
    const hidden = await boxChecks("behind", { x: 150, y: 400, width: 300, height: 400 }, steady);
    expect(hidden.map((check) => check.rule)).toEqual(["photo-hidden"]);
    expect(hidden[0]!.reason).toMatch(
      /^photo behind-photo behind you: the person covers \d+% of its height, more than 30%; move it out from behind the person or in front$/,
    );
    // Only its lower 30% behind the head: in view.
    expect(await boxChecks("behind", { x: 150, y: 300, width: 300, height: 400 }, steady)).toEqual(
      [],
    );
    // A stored photo in a spot (no box) is never checked for it.
    const stored = await behindChecks("left", steady);
    expect(stored.filter((check) => check.rule === "photo-hidden")).toEqual([]);
  });
});
