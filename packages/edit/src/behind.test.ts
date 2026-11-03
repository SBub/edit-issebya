import { describe, expect, it } from "vitest";
import { bigWordLayout, maskSpans, spotBox } from "./behind.ts";
import { build } from "./build.ts";
import { faceBox } from "./head-track.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { BehindItem, BehindWordItem, Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
const PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";
const FRAME = 1 / 30;

function word(text: string): BehindWordItem {
  return { id: "big", kind: "word", text, start: { time: 0 }, end: { time: 3 } };
}

// The behind fixture with its behind track replaced by items at fixed times.
function withBehind(
  items: { start: number; end: number }[],
  duration = behind.edit.duration,
): Edit {
  const edit = structuredClone(behind.edit);
  edit.duration = duration;
  edit.tracks.behind = items.map(({ start, end }, index): BehindItem => ({
    id: `b${index}`,
    kind: "photo",
    photo_id: PHOTO,
    spot: "top",
    start: { time: start },
    end: { time: end },
  }));
  return edit;
}

describe("spotBox", () => {
  it("gives each spot's preset rectangle", () => {
    expect(spotBox("top", ISSEBYA_PRESET)).toEqual({ left: 90, right: 990, top: 160, bottom: 760 });
    expect(spotBox("left", ISSEBYA_PRESET)).toEqual({
      left: 40,
      right: 500,
      top: 560,
      bottom: 1180,
    });
    expect(spotBox("right", ISSEBYA_PRESET)).toEqual({
      left: 580,
      right: 1040,
      top: 560,
      bottom: 1180,
    });
  });
});

describe("bigWordLayout", () => {
  it("sets a short word at the preset's largest size, centred, below the head top", async () => {
    const measurer = await nodeMeasurer();
    const box = bigWordLayout(
      word("AI"),
      { start: 1, end: 3 },
      behind.headTrack,
      ISSEBYA_PRESET,
      measurer,
    );
    expect(box.size).toBe(400);
    expect(box.x + box.width / 2).toBeCloseTo(540, 0);
    const face = faceBox(behind.headTrack, 1, 1)!;
    expect(box.y + box.size / 2).toBeCloseTo(face.top + 60, 0);
    expect(measurer.widths()).toHaveProperty("secondary:AI");
  });

  it("shrinks a long word to the frame between the side margins", async () => {
    const box = bigWordLayout(
      word("rethinking"),
      { start: 1, end: 3 },
      behind.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(box.size).toBeLessThan(400);
    expect(box.width).toBeLessThanOrEqual(1080 - 2 * 40);
    expect(box.x).toBeGreaterThanOrEqual(40);
  });

  it("uses the preset's line with no head in the frame", async () => {
    const box = bigWordLayout(
      word("AI"),
      { start: 1, end: 3 },
      [null, null],
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(box.y + box.size / 2).toBe(700);
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
  it("places the photo exactly over its spot and lists masks and photos as assets", async () => {
    const { html, assets } = build(
      behind.edit,
      behind.transcript,
      behind.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain(
      `<img id="behind-photo" class="clip photo" src="photos/${PHOTO}.jpg" alt="" data-start="5.206" data-duration="2.632" data-track-index="21" style="left: 90px; top: 160px; width: 900px; height: 600px" />`,
    );
    expect(html.match(/<video /g)).toHaveLength(9);
    expect(html).not.toContain("#behind-photo");
    expect(assets.filter((asset) => !["font", "sound"].includes(asset.role))).toEqual([
      {
        path: `masks/${"1".repeat(64)}.mp4`,
        role: "mask",
        ref: { step: "cutout", fingerprint: "1".repeat(64), file: "mask.mp4" },
      },
      {
        path: `masks/${"2".repeat(64)}.mp4`,
        role: "mask",
        ref: { step: "cutout", fingerprint: "2".repeat(64), file: "mask.mp4" },
      },
      { path: `photos/${PHOTO}.jpg`, role: "photo", ref: null, photoId: PHOTO },
      { path: "source.mp4", role: "footage", ref: behind.edit.inputs.footage },
    ]);
  });

  it("throws for a behind item whose span has no mask", async () => {
    const edit = structuredClone(behind.edit);
    edit.inputs.masks = edit.inputs.masks!.slice(1);
    await expect(async () =>
      build(edit, behind.transcript, behind.headTrack, ISSEBYA_PRESET, await nodeMeasurer()),
    ).rejects.toThrow("build: behind item behind-photo has no cut-out");
  });
});
