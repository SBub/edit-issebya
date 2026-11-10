import { describe, expect, it } from "vitest";
import {
  HAIR_MARGIN,
  bigWordNeedsCutout,
  maskSpans,
  needsCutout,
  paddedSpan,
  visualBox,
} from "./behind.ts";
import { build } from "./build.ts";
import { headTrackSchema } from "./head-track.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { BehindItem, BehindWordItem, Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
const engine = FIXTURES.find((fixture) => fixture.name === "rethink-work-engine")!;
const FRAME = 1 / 30;

function word(text: string): BehindWordItem {
  return { id: "big", kind: "word", text, start: { time: 0 }, end: { time: 3 } };
}

// The behind fixture with its behind track replaced by big words at fixed
// times (the only items with a cut-out).
function withBehind(
  items: { start: number; end: number }[],
  duration = behind.edit.duration,
): Edit {
  const edit = structuredClone(behind.edit);
  edit.duration = duration;
  edit.tracks.behind = items.map(({ start, end }, index): BehindItem => ({
    id: `b${index}`,
    kind: "word",
    text: "WORK",
    start: { time: start },
    end: { time: end },
  }));
  return edit;
}

describe("visual boxes", () => {
  const item = (more: Partial<BehindItem> = {}) =>
    ({
      id: "v",
      kind: "visual",
      box: { x: 40, y: 560, width: 460, height: 620 },
      start: { time: 0 },
      end: { time: 2 },
      ...more,
    }) as Extract<BehindItem, { kind: "visual" }>;

  it("is the box the engine gave it", () => {
    expect(visualBox(item())).toEqual({ left: 40, right: 500, top: 560, bottom: 1180 });
    expect(visualBox(item({ box: { x: 100, y: 220, width: 640, height: 480 } }))).toEqual({
      left: 100,
      right: 740,
      top: 220,
      bottom: 700,
    });
  });

  it("only what sits behind needs the cut-out", () => {
    expect(needsCutout(item())).toBe(false);
    expect(needsCutout(word("WORK"))).toBe(true);
  });

  it("a big word the head cannot reach needs none; a stored word without the field still needs it", () => {
    expect(needsCutout({ ...word("WORK"), cutout: false })).toBe(false);
    expect(needsCutout({ ...word("WORK"), cutout: true })).toBe(true);
    expect(needsCutout(word("WORK"))).toBe(true);
  });
});

describe("bigWordNeedsCutout", () => {
  // A head whose top is at y 600 over the whole reel, and a word of the span
  // 10 s to 12 s (padded to 9.9 s to 12.1 s).
  const track = Array.from({ length: 200 }, (_, index) => ({
    t: index * 0.25,
    head_top: 600,
    cx: 540,
    head_w: 300,
  }));
  const span = { start: 10, end: 12 };
  const box = (bottom: number) => ({ left: 100, right: 900, top: bottom - 200, bottom });

  it("needs the cut-out when the word's bottom is below the highest head top less the hair margin", () => {
    expect(HAIR_MARGIN).toBe(20);
    // The line sits 20 px above the head: a bottom at it is clear, one px lower is not.
    expect(bigWordNeedsCutout(box(600 - HAIR_MARGIN), track, span)).toBe(false);
    expect(bigWordNeedsCutout(box(600 - HAIR_MARGIN + 1), track, span)).toBe(true);
    expect(bigWordNeedsCutout(box(900), track, span)).toBe(true);
  });

  it("reads the robust face: one stray higher reading does not decide", () => {
    const stray = track.map((sample) =>
      sample.t > 11 && sample.t < 11.5 ? { ...sample, head_top: 500 } : sample,
    );
    expect(bigWordNeedsCutout(box(560), stray, span)).toBe(false);
  });

  it("reads the highest face over the span: a head that stands higher for a while decides", () => {
    const higher = track.map((sample) =>
      sample.t >= 11 && sample.t <= 11.5 ? { ...sample, head_top: 500 } : sample,
    );
    expect(bigWordNeedsCutout(box(560), track, span)).toBe(false);
    expect(bigWordNeedsCutout(box(560), higher, span)).toBe(true);
  });

  it("decides on the same faces the placer reads: the cleaned track, glitches dropped", () => {
    // A glitch reading 424 over 10.25 to 10.75 s: with it, the word's box clears
    // no head top at 424 - 20; without it (the cleaned track), the real 600 decides.
    const glitched = track.map((sample) =>
      sample.t >= 10.25 && sample.t <= 10.75
        ? { t: sample.t, head_top: 424, cx: 540, head_w: 60 }
        : sample,
    );
    const cleaned = headTrackSchema.parse(glitched);
    expect(cleaned[41]).toBeNull();
    expect(bigWordNeedsCutout(box(560), cleaned, span)).toBe(false);
  });

  it("needs no cut-out with no head in the span, even with heads elsewhere", () => {
    const early = track.map((sample) => (sample.t < 5 ? sample : null));
    expect(bigWordNeedsCutout(box(900), early, span)).toBe(false);
    expect(bigWordNeedsCutout(box(900), [], span)).toBe(false);
  });
});

describe("paddedSpan", () => {
  it("is the mask span of a big word: padded by the preset's frames, clamped, to the millisecond", () => {
    // Whole frames: 5.01 s less 3 frames (0.1 s) is 4.91 s, the frame at 4.9 s.
    expect(paddedSpan({ start: 5.01, end: 7.5 }, 50, ISSEBYA_PRESET)).toEqual({
      start: 4.9,
      end: 7.6,
    });
    expect(paddedSpan({ start: 0, end: 2.5 }, 20, ISSEBYA_PRESET)).toEqual({ start: 0, end: 2.6 });
  });
});

describe("maskSpans", () => {
  it("pads each item by three frames on the frame grid", () => {
    const [span] = maskSpans(withBehind([{ start: 5.01, end: 7.5 }]), behind.transcript, {
      ...ISSEBYA_PRESET,
    });
    // 5.01 - 0.1 = 4.91 snaps down to 4.9; 7.5 + 0.1 = 7.6 is a frame time.
    expect(span).toEqual({ start: 4.9, end: 7.6, items: ["b0"] });
    expect(Math.abs(span!.start / FRAME - Math.round(span!.start / FRAME))).toBeLessThan(0.02);
  });

  it("leaves out a VISUAL, which sits in front of the speaker: it needs no mask", () => {
    const edit = withBehind([
      { start: 5, end: 7 },
      { start: 10, end: 12 },
    ]);
    edit.tracks.behind![0] = {
      id: "b0",
      kind: "visual",
      box: { x: 90, y: 160, width: 900, height: 600 },
      start: { time: 5 },
      end: { time: 7 },
    };
    expect(maskSpans(edit, behind.transcript, ISSEBYA_PRESET).map((span) => span.items)).toEqual([
      ["b1"],
    ]);
  });

  it("clamps to the reel's start and end", () => {
    const spans = maskSpans(
      withBehind(
        [
          { start: 0, end: 2.5 },
          { start: 17.5, end: 20 },
        ],
        20,
      ),
      behind.transcript,
      ISSEBYA_PRESET,
    );
    expect(spans.map(({ start, end }) => [start, end])).toEqual([
      [0, 2.6],
      [17.4, 20],
    ]);
  });

  it("merges items closer than twice the padding, sorted", () => {
    const spans = maskSpans(
      withBehind([
        { start: 30, end: 33 },
        { start: 10, end: 12.5 },
        { start: 12.6, end: 15 },
      ]),
      behind.transcript,
      ISSEBYA_PRESET,
    );
    expect(spans).toEqual([
      { start: 9.9, end: 15.1, items: ["b1", "b2"] },
      { start: 29.9, end: 33.1, items: ["b0"] },
    ]);
  });

  it("skips a big word the head cannot reach: no span, no mask", () => {
    const edit = withBehind([
      { start: 5, end: 7 },
      { start: 30, end: 33 },
    ]);
    edit.tracks.behind![1] = { ...edit.tracks.behind![1]!, cutout: false } as BehindItem;
    expect(maskSpans(edit, behind.transcript, ISSEBYA_PRESET).map((span) => span.items)).toEqual([
      ["b0"],
    ]);
  });

  it("is empty without a behind track", () => {
    const edit = structuredClone(behind.edit);
    delete edit.tracks.behind;
    expect(maskSpans(edit, behind.transcript, ISSEBYA_PRESET)).toEqual([]);
  });
});

describe("build with behind items", () => {
  it("places the visual exactly over its box and lists its masks as assets", async () => {
    const { html, assets } = build(
      engine.edit,
      engine.transcript,
      engine.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    // The card shows its stand-in picture, at the picture's aspect.
    expect(html).toContain(
      `<div id="visual-1" class="clip visual-picture" data-start="5.206" data-duration="2.000" data-track-index="30" style="left: 75px; top: 1047px; width: 300px; height: 383px">\n  <img src="assets/visuals/visual-1.jpg" alt="">\n</div>`,
    );
    expect(html).not.toContain("photo");
    expect(assets.filter((asset) => !["font", "sound"].includes(asset.role))).toEqual([
      { path: "assets/visuals/visual-1.jpg", role: "visual", ref: null },
      {
        path: `masks/${"3".repeat(64)}.mp4`,
        role: "mask",
        ref: { step: "cutout", fingerprint: "3".repeat(64), file: "mask.mp4" },
      },
      { path: "source.mp4", role: "footage", ref: engine.edit.inputs.footage },
    ]);
  });

  it("throws for a big word whose span has no mask", async () => {
    const edit = structuredClone(engine.edit);
    edit.inputs.masks = [];
    await expect(async () =>
      build(edit, engine.transcript, engine.headTrack, ISSEBYA_PRESET, await nodeMeasurer()),
    ).rejects.toThrow("has no cut-out");
  });
});
