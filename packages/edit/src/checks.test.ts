import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import type { HeadTrack } from "./head-track.ts";
import { ISSEBYA_PRESET, PLATFORM_BUTTONS, PLATFORM_SAFE } from "./preset.ts";
import type { Edit } from "./schema.ts";
import type { EngineNote } from "./engine-note.ts";
import { FIXTURES, PLACED_FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { resolveTimeline } from "./timeline.ts";

// The behind edit's choices placed by the layout engine: every check passes.
const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-engine")!;

async function checksOf(edit: Edit, headTrack: HeadTrack = hand.headTrack) {
  return build(edit, hand.transcript, headTrack, ISSEBYA_PRESET, await nodeMeasurer()).checks;
}

describe("runChecks", () => {
  it("passes the engine-placed fixture versions (an empty list)", async () => {
    for (const fixture of PLACED_FIXTURES) {
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
    expect(checks[0]).toMatchObject({ rule: "safe-box", item: "accent-1" });
    expect(checks[0]!.reason).toMatch(
      /^accent accent-1 \("a{40}"\) runs past the safe box: right edge \d+ > 1045$/,
    );
  });

  it("fails safe-box for a caption set at y 1440", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.position = { x: 540, y: 1440, align: "center" };
    const checks = (await checksOf(edit)).filter((check) => check.rule === "safe-box");
    expect(checks.map((check) => check.item)).toEqual(["cw0"]);
    expect(checks[0]!.reason).toMatch(/runs past the safe box: bottom edge 1490 > 1470$/);
  });

  async function safeBoxAt(position: { x: number; y: number; align: "right" }) {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.position = position;
    const { checks } = build(
      edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    // The layout may set other text past the guard too; only the moved
    // caption is looked at.
    return checks.filter((check) => check.rule === "safe-box" && check.item === "cw0");
  }

  it("checks against the platform guard (the one safe zone)", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.position = { x: 540, y: 1450, align: "center" };
    const { checks } = build(
      edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    const cw0 = checks.find((check) => check.rule === "safe-box" && check.item === "cw0");
    expect(cw0?.reason).toMatch(/runs past the safe box: bottom edge 1500 > 1470$/);
  });

  it("fails safe-box for text in the button column's notch, passes it higher up", async () => {
    // Right-aligned to the guard's right edge: inside the outer box either way.
    const low = await safeBoxAt({ x: 1040, y: PLATFORM_BUTTONS.top + 40, align: "right" });
    expect(low).toHaveLength(1);
    expect(low[0]!.reason).toMatch(
      /runs into the platform button column below y 1164: right edge 1040 > 945$/,
    );
    expect(await safeBoxAt({ x: 1040, y: PLATFORM_BUTTONS.top - 100, align: "right" })).toEqual([]);
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

  it("checks a transition's levels for the safe box, never its hidden captions", async () => {
    const transitions = FIXTURES.find((f) => f.name === "rethink-work-transitions")!;
    const levelChecks = async (edit: Edit) =>
      build(
        edit,
        transitions.transcript,
        transitions.headTrack,
        ISSEBYA_PRESET,
        await nodeMeasurer(),
      ).checks;
    // Hidden captions with no place trip no timing or face check.
    expect(await levelChecks(transitions.edit)).toEqual([]);
    const low = structuredClone(transitions.edit);
    low.tracks.transitions[0]!.levels!.key.position.y = 1380;
    expect(
      (await levelChecks(low)).filter((check) => check.rule === "safe-box").map((c) => c.item),
    ).toEqual(["transition-1-key"]);
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
  it("skips the safe box for a big word (it crosses the frame by design)", async () => {
    const { checks, html } = build(
      hand.edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain('id="big-word-1"');
    expect(checks).toEqual([]);
  });

  it("fails big-word-timing for a big word shown before the word it is set on", async () => {
    const edit = structuredClone(hand.edit);
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    // On the captions' line (behind the body too), and a word said only after
    // it shows.
    if (word.kind === "word") Object.assign(word, { position: { x: 42, y: 1000 }, text: "work" });
    const { checks } = build(
      edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    // The word also sits on the captions (a `text-overlap`, checked below):
    // this test is about its timing only.
    const rules = [...new Set(checks.map((check) => check.rule))].filter(
      (rule) => rule !== "text-overlap",
    );
    expect(rules).toEqual(["big-word-timing"]);
    expect(checks.find((check) => check.rule === "big-word-timing")!.reason).toMatch(
      /^big word big-word-1 \("work"\) shows at \d+\.\d{3} s, more than 0\.2 s before w95 is said at 24\.887 s$/,
    );
  });

  it("passes big-word-timing for a big word coming in the lead before its word", async () => {
    const word = hand.edit.tracks.behind!.find((item) => item.kind === "word")!;
    expect(word.start).toMatchObject({ offset: -ISSEBYA_PRESET.accent.leadSeconds });
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

  it("fails safe-box for a big word set past the safe box's bottom edge: the big word keeps S like every text", async () => {
    const edit = structuredClone(hand.edit);
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    if (word.kind !== "word") throw new Error("not a word");
    Object.assign(word, { position: { x: word.position!.x, y: 1900 } });
    const { checks } = build(
      edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    const failed = checks.filter((check) => check.rule === "safe-box");
    expect(failed.map((check) => check.item)).toEqual(["big-word-1"]);
    expect(failed[0]!.reason).toBe(
      `big word big-word-1 ("distribution") runs past the safe box: bottom edge ${1900 + word.size!} > ${PLATFORM_SAFE.bottom}`,
    );
  });
});

describe("runChecks on text overlap", () => {
  // Two texts shown at a shared moment, the second moved onto the first's place.
  function overlapping(): { edit: Edit; first: string; second: string } {
    const edit = structuredClone(hand.edit);
    const spans = resolveTimeline(edit, hand.transcript);
    const texts = [
      ...edit.tracks.captions.filter((caption) => caption.position && !caption.hidden_by),
      ...edit.tracks.overlays.filter((item) => item.position),
    ];
    for (const [index, first] of texts.entries()) {
      const a = spans.get(first.id)!;
      const second = texts
        .slice(index + 1)
        .find((other) => spans.get(other.id)!.start < a.end && a.start < spans.get(other.id)!.end);
      if (second) {
        second.position = { ...first.position! };
        return { edit, first: first.id, second: second.id };
      }
    }
    throw new Error("no two texts share a moment in the fixture");
  }

  const buildWith = async (edit: Edit, engineRecord?: readonly EngineNote[]) =>
    build(edit, hand.transcript, hand.headTrack, ISSEBYA_PRESET, await nodeMeasurer(), {
      engineRecord,
    }).checks.filter((check) => check.rule === "text-overlap");

  it("reports a text on another text shown at the same moment, with no record", async () => {
    const { edit, second } = overlapping();
    const checks = await buildWith(edit);
    expect(checks.map((check) => check.item)).toContain(second);
  });

  it("excuses the pair a caption's no-spot note names (decision 19), and no other", async () => {
    // `first` is a caption (the captions come first in the fixture's texts).
    const { edit, first, second } = overlapping();
    expect(first).toMatch(/^cw/);
    const noSpot: EngineNote = {
      item: first,
      component: "CAPTION",
      variant: "caption/default",
      start: 0,
      end: 1,
      rule: "no-spot",
      outcome: "no-spot",
      blockers: [{ kind: "caption", id: second }],
      reason: "no spot: set over the text",
    };
    expect(await buildWith(edit, [noSpot])).toEqual([]);
    // The note names the other text: a blocker naming a third text is no excuse,
    // nor is a note of another outcome, nor a component's no-spot (a component
    // with no spot is left out, never set over text).
    const named = (id: string) => ({ ...noSpot, blockers: [{ kind: "item" as const, id }] });
    expect(await buildWith(edit, [named("nobody")])).not.toEqual([]);
    expect(await buildWith(edit, [{ ...noSpot, outcome: "covers-face" }])).not.toEqual([]);
    expect(
      await buildWith(edit, [{ ...noSpot, component: "ACCENT", variant: "accent/above-head" }]),
    ).not.toEqual([]);
  });
});

describe("runChecks on the same text", () => {
  // The fixture's caption cw109 shows a word; a copy of an accent showing that
  // same word at the same moment is the second item.
  function sameWord(): Edit {
    const edit = structuredClone(hand.edit);
    const caption = edit.tracks.captions.find((item) => item.id === "cw109")!;
    const word = caption.words[0]!;
    const accent = structuredClone(edit.tracks.overlays.find((item) => item.kind === "accent")!);
    Object.assign(accent, {
      id: "accent-copy",
      words: [word],
      start: { word, edge: "start" },
      end: { word, edge: "end" },
    });
    edit.tracks.overlays.push(accent);
    return edit;
  }

  it("reports a spoken word two items show at a shared moment, naming both", async () => {
    const same = (await checksOf(sameWord())).filter((check) => check.rule === "same-text");
    expect(same).toHaveLength(1);
    expect(same[0]!.item).toBe("accent-copy");
    expect(same[0]!.reason).toMatch(
      /^cw109 and accent-copy both show "[^"]+" from \d+\.\d{3} to \d+\.\d{3} s$/,
    );
  });

  it("passes once the caption leaves the word out while the text shows it", async () => {
    const edit = sameWord();
    edit.tracks.captions.find((item) => item.id === "cw109")!.hidden_by = "accent-copy";
    expect((await checksOf(edit)).filter((check) => check.rule === "same-text")).toEqual([]);
  });
});
