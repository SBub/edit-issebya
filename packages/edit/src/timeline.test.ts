import { describe, expect, it } from "vitest";
import { ISSEBYA_PRESET } from "./preset.ts";
import { parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

function retimed(map: (t: number) => number): Transcript {
  return {
    words: hand.transcript.words.map((word) => ({
      ...word,
      start: Math.round(map(word.start) * 1000) / 1000,
      end: Math.round(map(word.end) * 1000) / 1000,
    })),
  };
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

describe("resolveTimeline", () => {
  for (const [name, transcript] of [
    ["shifted", retimed((t) => t + 0.5)],
    ["stretched", retimed((t) => t * 0.9)],
  ] as const) {
    it(`items follow their words through a ${name} transcript`, () => {
      const edit = structuredClone(hand.edit);
      // The re-timed reel's length.
      edit.duration = ms(Math.max(...transcript.words.map((word) => word.end)) + 0.2);
      edit.tracks.overlays.push({
        id: "at-time",
        kind: "accent",
        text: "x",
        start: { time: 0.1 },
        end: { time: 0.2 },
      });
      expect(parseEdit(edit, ISSEBYA_PRESET, transcript)).toMatchObject({ ok: true });
      const before = resolveTimeline(edit, hand.transcript);
      const after = resolveTimeline(edit, transcript);
      const words = new Map(transcript.words.map((word) => [word.id, word]));
      for (const caption of edit.tracks.captions) {
        const start = words.get((caption.start as { word: string }).word)!;
        const end = words.get((caption.end as { word: string }).word)!;
        expect(after.get(caption.id)).toEqual({ start: start.start, end: end.end, clamped: false });
      }
      const transition = edit.tracks.transitions[0]!;
      expect(after.get(transition.id)!.start).toBe(ms(words.get("w126")!.start - 0.03));
      expect(after.get(transition.id)!.end).toBe(words.get("w133")!.end);
      // A time anchor stays where it is; the reel's ends do not depend on words.
      expect(after.get("at-time")).toEqual(before.get("at-time"));
      expect(after.get("footage")).toEqual({ start: 0, end: edit.duration, clamped: false });
    });
  }

  it("follows the reel's end to the duration and clamps anchors outside the reel", () => {
    const edit = structuredClone(hand.edit);
    edit.duration = 40;
    edit.tracks.overlays.push({
      id: "early",
      kind: "accent",
      text: "x",
      start: { word: "w0", offset: -0.5 },
      end: { word: "w0", edge: "end" },
    });
    const resolved = resolveTimeline(edit, hand.transcript);
    expect(resolved.get("footage")!.end).toBe(40);
    expect(resolved.get("early")).toEqual({ start: 0, end: 0.355, clamped: true });
  });
});
