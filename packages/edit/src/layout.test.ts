import { describe, expect, it } from "vitest";
import { type HeadTrack, faceBox } from "./head-track.ts";
import { layoutText } from "./layout.ts";
import { ISSEBYA_PRESET, PLATFORM_SAFE } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { resolveTimeline } from "./timeline.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

async function boxesOf(edit: Edit, headTrack: HeadTrack) {
  const resolved = resolveTimeline(edit, hand.transcript);
  return layoutText(
    edit,
    resolved,
    hand.transcript,
    headTrack,
    ISSEBYA_PRESET,
    await nodeMeasurer(),
  );
}

// A head low in the frame: face 745 to 1150 (1.35 head widths tall).
const lowHead: HeadTrack = Array.from({ length: 400 }, (_, index) => ({
  t: index * 0.25,
  head_top: 745,
  cx: 540,
  head_w: 300,
}));

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { left: number; right: number; top: number; bottom: number },
) {
  return a.x < b.right && b.left < a.x + a.width && a.y < b.bottom && b.top < a.y + a.height;
}

describe("layoutText at the bottom edge", () => {
  it("keeps every fixture's text inside the platform guard", async () => {
    for (const fixture of FIXTURES) {
      const resolved = resolveTimeline(fixture.edit, fixture.transcript);
      const boxes = layoutText(
        fixture.edit,
        resolved,
        fixture.transcript,
        fixture.headTrack,
        ISSEBYA_PRESET,
        await nodeMeasurer(),
      );
      for (const box of boxes) {
        expect(box.x, `${fixture.name} ${box.itemId}`).toBeGreaterThanOrEqual(PLATFORM_SAFE.left);
        expect(box.x + box.width, `${fixture.name} ${box.itemId}`).toBeLessThanOrEqual(
          PLATFORM_SAFE.right,
        );
        expect(box.y, `${fixture.name} ${box.itemId}`).toBeGreaterThanOrEqual(PLATFORM_SAFE.top);
        expect(box.y + box.height, `${fixture.name} ${box.itemId}`).toBeLessThanOrEqual(
          PLATFORM_SAFE.bottom,
        );
      }
    }
  });

  it("keeps captions beside a low head above 1164 and off the face", async () => {
    // No transition: its text area covers the footage by design.
    const edit = structuredClone(hand.edit);
    edit.tracks.transitions = [];
    const boxes = await boxesOf(edit, lowHead);
    const captions = boxes.filter((box) => box.kind === "caption");
    expect(captions.length).toBeGreaterThan(0);
    for (const box of captions) {
      expect(box.y + box.height, box.itemId).toBeLessThanOrEqual(1164);
      const face = faceBox(lowHead, box.start, box.end, { left: 0, right: 0 })!;
      expect(overlaps(box, face), box.itemId).toBe(false);
    }
  });

  it("moves a two-line fallback block up to end at or above 1164", async () => {
    const edit = structuredClone(hand.edit);
    for (const caption of edit.tracks.captions.slice(0, 4)) caption.text = "extraordinarily";
    const boxes = await boxesOf(edit, [null, null]);
    const group = boxes.filter((box) => ["cw0", "cw1", "cw2", "cw3"].includes(box.itemId));
    expect(new Set(group.map((box) => box.y)).size).toBeGreaterThan(1);
    for (const box of group) expect(box.y + box.height, box.itemId).toBeLessThanOrEqual(1164);
  });

  it("never sets a 120 px caption in a row that crosses 1164", async () => {
    const edit = structuredClone(hand.edit);
    for (const caption of edit.tracks.captions) caption.size = 120;
    const boxes = await boxesOf(edit, lowHead);
    for (const box of boxes.filter((b) => b.kind === "caption")) {
      expect(box.y + box.height, box.itemId).toBeLessThanOrEqual(1164);
    }
  });
});
