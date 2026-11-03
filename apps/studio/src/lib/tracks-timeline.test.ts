import {
  type Edit,
  ISSEBYA_PRESET,
  parseEdit,
  resolveTimeline,
  transcriptSchema,
} from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import behindEdit from "../../../../packages/edit/src/testdata/versions/rethink-work-behind.edit.json" with { type: "json" };
import handEdit from "../../../../packages/edit/src/testdata/versions/rethink-work-hand.edit.json" with { type: "json" };
import baselineEdit from "../../../../packages/edit/src/testdata/versions/baseline-short-speech.edit.json" with { type: "json" };
import handTranscript from "../../../../packages/edit/src/testdata/rethink-work/transcript.json" with { type: "json" };
import speechTranscript from "../../../../fixtures/pipeline/retime/transcript.json" with { type: "json" };
import { formatClock, frameIndexAt, rulerTicks, timelineRows } from "./tracks-timeline";

function parsed(json: unknown, transcriptJson: unknown) {
  const transcript = transcriptSchema.parse(transcriptJson);
  const result = parseEdit(json, ISSEBYA_PRESET, transcript);
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return { edit: result.edit as Edit, transcript };
}

const LAYOUT = { everySeconds: 2, columns: 32, width: 90, height: 160 };

describe("timelineRows", () => {
  it("lays every item of a full edit at resolveTimeline's span, in the six rows", () => {
    const { edit, transcript } = parsed(handEdit, handTranscript);
    const timeline = timelineRows(edit, transcript);
    const resolved = resolveTimeline(edit, transcript);
    expect(timeline.duration).toBe(edit.duration);
    expect(timeline.rows.map((row) => [row.key, row.label])).toEqual([
      ["footage", "Footage"],
      ["behind", "Behind"],
      ["captions", "Captions"],
      ["overlays", "Accents"],
      ["transitions", "Transitions"],
      ["sounds", "Sounds"],
    ]);
    const shown = timeline.rows.flatMap((row) => row.items);
    for (const item of shown) {
      const span = resolved.get(item.id)!;
      expect([item.start, item.end]).toEqual([span.start, span.end]);
    }
    const counts = Object.fromEntries(timeline.rows.map((row) => [row.key, row.items.length]));
    expect(counts).toEqual({
      footage: edit.tracks.footage.length,
      behind: 0,
      captions: edit.tracks.captions.length,
      overlays: edit.tracks.overlays.length,
      transitions: edit.tracks.transitions.length,
      sounds: edit.tracks.sounds.length,
    });
  });

  it("shows the behind items in their row: a photo by its spot, a word by itself", () => {
    const { edit, transcript } = parsed(behindEdit, handTranscript);
    const row = timelineRows(edit, transcript).rows.find((entry) => entry.key === "behind")!;
    expect(row.items.map((item) => [item.id, item.label])).toEqual([
      ["behind-photo", "photo right"],
      ["behind-word", "WORK"],
    ]);
    expect(row.items[0]).toMatchObject({ start: 5.206, end: 7.838 });
  });

  it("never shows the legacy cut-out track", () => {
    const { edit, transcript } = parsed(handEdit, handTranscript);
    expect(edit.tracks.cutout?.length).toBeGreaterThan(0);
    const ids = new Set(
      timelineRows(edit, transcript).rows.flatMap((row) => row.items.map((item) => item.id)),
    );
    for (const clip of edit.tracks.cutout ?? []) {
      if (!edit.tracks.footage.some((footage) => footage.id === clip.id)) {
        expect(ids.has(clip.id)).toBe(false);
      }
    }
  });

  it("labels each kind: clip length, words, accent words, transition type, sound key", () => {
    const { edit, transcript } = parsed(handEdit, handTranscript);
    const rows = Object.fromEntries(
      timelineRows(edit, transcript).rows.map((row) => [row.key, row.items]),
    );
    expect(rows.footage![0]!.label).toBe(formatClock(edit.duration));
    expect(rows.captions![0]!.label).not.toBe("");
    expect(rows.overlays![0]!.label).not.toBe("");
    expect(rows.transitions![0]!.label).toBe(edit.tracks.transitions[0]!.type);
    expect(rows.sounds![0]!.label).toBe(edit.tracks.sounds[0]!.sound);
  });

  it("keeps the empty rows of the baseline version", () => {
    const { edit, transcript } = parsed(baselineEdit, speechTranscript);
    const rows = timelineRows(edit, transcript).rows;
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.key === "captions")!.items.length).toBeGreaterThan(0);
    expect(rows.find((row) => row.key === "overlays")!.items).toEqual([]);
    expect(rows.find((row) => row.key === "transitions")!.items).toEqual([]);
    expect(rows.find((row) => row.key === "sounds")!.items).toEqual([]);
    expect(rows.find((row) => row.key === "behind")!.items).toEqual([]);
  });
});

describe("formatClock", () => {
  it("floors to mm:ss and never goes negative", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(52.4)).toBe("00:52");
    expect(formatClock(59.999)).toBe("00:59");
    expect(formatClock(60)).toBe("01:00");
    expect(formatClock(125.7)).toBe("02:05");
    expect(formatClock(-3)).toBe("00:00");
    expect(formatClock(Number.NaN)).toBe("00:00");
  });
});

describe("rulerTicks", () => {
  it("ticks every second, labelled every 5 s", () => {
    const ticks = rulerTicks(11.5);
    expect(ticks.map((tick) => tick.seconds)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ticks.filter((tick) => tick.label).map((tick) => tick.label)).toEqual([
      "00:00",
      "00:05",
      "00:10",
    ]);
  });

  it("labels every 10 s past a minute", () => {
    const labels = rulerTicks(75)
      .filter((tick) => tick.label)
      .map((tick) => tick.seconds);
    expect(labels).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });

  it("is empty for no duration", () => {
    expect(rulerTicks(0)).toEqual([]);
    expect(rulerTicks(-1)).toEqual([]);
  });
});

describe("frameIndexAt", () => {
  it("picks one frame every everySeconds", () => {
    expect(frameIndexAt(0, LAYOUT)).toBe(0);
    expect(frameIndexAt(1.99, LAYOUT)).toBe(0);
    expect(frameIndexAt(2, LAYOUT)).toBe(1);
    expect(frameIndexAt(63.9, LAYOUT)).toBe(31);
  });

  it("clamps to the sprite: before the clip, past 64 s, not a number", () => {
    expect(frameIndexAt(-1, LAYOUT)).toBe(0);
    expect(frameIndexAt(64, LAYOUT)).toBe(31);
    expect(frameIndexAt(500, LAYOUT)).toBe(31);
    expect(frameIndexAt(Number.NaN, LAYOUT)).toBe(0);
  });
});
