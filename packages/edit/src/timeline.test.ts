import { describe, expect, it } from "vitest";
import { ISSEBYA_PRESET } from "./preset.ts";
import { parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { phraseWords, resolveTimeline } from "./timeline.ts";
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

describe("resolveTimeline with behind items", () => {
  it("resolves the behind track like any other", () => {
    const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
    const resolved = resolveTimeline(behind.edit, behind.transcript);
    expect(resolved.get("behind-photo")).toEqual({ start: 5.206, end: 7.838, clamped: false });
    expect(resolved.get("behind-word")).toEqual({ start: 20.068, end: 22.613, clamped: false });
  });
});

describe("resolveTimeline with phrase transitions", () => {
  const fixture = FIXTURES.find((entry) => entry.name === "rethink-work-transitions")!;
  const word = (id: string) => fixture.transcript.words.find((entry) => entry.id === id)!;

  function spanOf(change: Record<string, unknown>, transcript: Transcript = fixture.transcript) {
    const edit = structuredClone(fixture.edit);
    const item = edit.tracks.transitions.find((entry) => entry.id === "t-live")!;
    Object.assign(item, change);
    return resolveTimeline(edit, transcript).get("t-live")!;
  }

  it("starts each library type its motion before the first word", () => {
    const resolved = resolveTimeline(fixture.edit, fixture.transcript);
    expect(resolved.get("t-live")!.start).toBe(ms(word("w91").start - 0.3));
    expect(resolved.get("t-fund-life")!.start).toBe(ms(word("w126").start - 0.5));
    expect(resolved.get("t-want")!.start).toBe(ms(word("w145").start - 0.3));
    expect(spanOf({ motion_seconds: 0.8 }).start).toBe(ms(word("w91").start - 0.8));
  });

  it("ends when the next word starts after a pause under the hold", () => {
    // w99 ends at 26.033, w100 starts at 26.124.
    expect(spanOf({}).end).toBe(word("w100").start);
  });

  it("ends the hold after the last word when the pause is longer", () => {
    const transcript: Transcript = {
      words: fixture.transcript.words.map((entry) =>
        entry.id === "w100" ? { ...entry, start: 28 } : entry,
      ),
    };
    expect(spanOf({}, transcript).end).toBe(ms(word("w99").end + 1));
    expect(spanOf({ hold_seconds: 0 }, transcript).end).toBe(word("w99").end);
  });

  it("ends at the reel's end on the last word", () => {
    const resolved = resolveTimeline(fixture.edit, fixture.transcript);
    expect(resolved.get("t-want")).toEqual({
      start: ms(word("w145").start - 0.3),
      end: fixture.edit.duration,
      clamped: false,
    });
  });

  it("clamps a phrase whose first word comes under its motion after 0", () => {
    expect(
      spanOf({ from: "w0", key_from: undefined, to: "w3", type: "dim", number: undefined }),
    ).toMatchObject({ start: 0, clamped: true });
  });

  it("moves with its words through a re-timed transcript", () => {
    const shifted = retimed((t) => t + 0.5);
    const after = spanOf({}, shifted);
    const before = spanOf({});
    expect(after.start).toBe(ms(before.start + 0.5));
    expect(after.end).toBe(ms(before.end + 0.5));
  });

  it("splits the phrase into its lead-in and key phrase", () => {
    const { lead, key } = phraseWords(
      { from: "w91", key_from: "w96", to: "w99" },
      fixture.transcript,
    );
    expect(lead.map((entry) => entry.id)).toEqual(["w91", "w92", "w93", "w94", "w95"]);
    expect(key.map((entry) => entry.id)).toEqual(["w96", "w97", "w98", "w99"]);
    const whole = phraseWords({ from: "w126", to: "w133" }, fixture.transcript);
    expect(whole.lead).toEqual([]);
    expect(whole.key).toHaveLength(8);
  });
});
