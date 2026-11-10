import { describe, expect, it } from "vitest";
import { maskSpans, needsCutout, visualBox } from "./behind.ts";
import { build } from "./build.ts";
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
