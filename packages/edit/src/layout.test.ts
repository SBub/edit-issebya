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

describe("layoutText for phrase transitions", () => {
  const fixture = FIXTURES.find((entry) => entry.name === "rethink-work-transitions")!;
  const word = (id: string) => fixture.transcript.words.find((entry) => entry.id === id)!;

  async function layout(edit: Edit = fixture.edit) {
    const resolved = resolveTimeline(edit, fixture.transcript);
    const boxes = layoutText(
      edit,
      resolved,
      fixture.transcript,
      fixture.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    return { boxes, resolved };
  }

  it("absorbs the phrase's captions: no box of their own", async () => {
    const { boxes } = await layout();
    const ids = new Set(boxes.map((box) => box.itemId));
    for (const caption of fixture.edit.tracks.captions) {
      const n = Number(caption.words[0]!.slice(1));
      const inside = (n >= 91 && n <= 99) || (n >= 126 && n <= 133) || n >= 145;
      expect(ids.has(caption.id), caption.id).toBe(!inside);
    }
  });

  it("sets the lead-in in caption text and the key phrase in accent text", async () => {
    const { boxes } = await layout();
    const { captionText, accentText } = ISSEBYA_PRESET.roles;
    const lead = boxes.filter((box) => box.itemId === "t-want-lead");
    const key = boxes.filter((box) => box.itemId === "t-want-key");
    expect(lead.length).toBeGreaterThan(0);
    for (const box of lead) {
      expect(box).toMatchObject({ kind: "caption", transitionId: "t-want" });
      expect([box.font, box.color, box.size]).toEqual([captionText.font, captionText.color, 50]);
    }
    for (const box of key) {
      expect(box).toMatchObject({ kind: "accent", font: accentText.font, color: accentText.color });
    }
    expect(lead.map((box) => box.text).join(" ")).toBe(
      "maybe because we never stepped far away from our routine to actually hear",
    );
  });

  it("shows a fixed caption's text in its level", async () => {
    const edit = structuredClone(fixture.edit);
    const caption = edit.tracks.captions.find((item) => item.words[0] === "w97")!;
    caption.text = "WORK";
    const { boxes } = await layout(edit);
    const key = boxes.filter((box) => box.itemId === "t-live-key").map((box) => box.text);
    expect(key.join(" ")).toBe("they WORK to live");
  });

  it("brings the lead in on the first word, the key on key_from, both out with the layer", async () => {
    const { boxes, resolved } = await layout();
    const span = resolved.get("t-live")!;
    const number = boxes.find((box) => box.itemId === "t-live-number")!;
    const lead = boxes.find((box) => box.itemId === "t-live-lead")!;
    const key = boxes.find((box) => box.itemId === "t-live-key")!;
    expect([number.start, lead.start, key.start]).toEqual([
      word("w91").start,
      word("w91").start,
      word("w96").start,
    ]);
    for (const box of [number, lead, key]) expect(box.end).toBe(span.end);
  });

  it("sets numbered's number in accent text at its scale, above the lead-in", async () => {
    const { boxes } = await layout();
    const number = boxes.find((box) => box.itemId === "t-live-number")!;
    const lead = boxes.find((box) => box.itemId === "t-live-lead")!;
    expect(number).toMatchObject({ kind: "number", text: "3", font: "primary", size: 176 });
    expect(number.y + number.height).toBeLessThan(lead.y);
  });

  it("shrinks a long key phrase in the panel and keeps it inside the area", async () => {
    const { boxes } = await layout();
    const { text } = ISSEBYA_PRESET.transitions.panel;
    const key = boxes.filter((box) => box.itemId === "t-fund-life-key");
    expect(key.length).toBeGreaterThan(0);
    for (const box of key) {
      expect(box.size).toBeLessThan(110);
      expect(box.size).toBeGreaterThanOrEqual(110 * 0.6);
      expect(box.x).toBeGreaterThanOrEqual(text.left);
      expect(box.x + box.width).toBeLessThanOrEqual(text.right);
      expect(box.y).toBeGreaterThanOrEqual(text.top);
      expect(box.y + box.height).toBeLessThanOrEqual(text.bottom);
    }
  });

  it("ends a caption crossing a phrase transition's start at that start", async () => {
    const edit = structuredClone(fixture.edit);
    const caption = edit.tracks.captions.find((item) => item.words[0] === "w144")!;
    caption.end = { word: "w150", edge: "end" };
    const { boxes, resolved } = await layout(edit);
    expect(boxes.find((box) => box.itemId === caption.id)!.end).toBe(resolved.get("t-want")!.start);
  });
});
