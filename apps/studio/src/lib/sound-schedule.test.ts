import { ISSEBYA_PRESET, type Edit, parseEdit, transcriptSchema } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import transcriptJson from "../../../../fixtures/pipeline/retime/transcript.json" with { type: "json" };
import baselineJson from "../../../../packages/edit/src/testdata/versions/baseline-short-speech.edit.json" with { type: "json" };
import { type SoundHit, scheduleAt, soundHits } from "./sound-schedule";

const transcript = transcriptSchema.parse(transcriptJson);

function withClicks(gainDb?: number): Edit {
  const json = structuredClone(baselineJson) as { tracks: { sounds: unknown[] } };
  json.tracks.sounds = [
    {
      id: "click-a",
      sound: "click",
      start: { word: "w0002" },
      end: { word: "w0002", offset: 0.2 },
      ...(gainDb === undefined ? {} : { gain_db: gainDb }),
    },
    {
      id: "click-b",
      sound: "click",
      start: { word: "w0005" },
      end: { word: "w0005", offset: 0.2 },
    },
  ];
  const parsed = parseEdit(json, ISSEBYA_PRESET, transcript);
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  return parsed.edit;
}

describe("soundHits", () => {
  it("resolves each click on its word anchor, file and length from the preset", () => {
    expect(soundHits(withClicks(), transcript, ISSEBYA_PRESET)).toEqual([
      {
        id: "click-a",
        file: "assets/sounds/mouse-click-trimmed.wav",
        at: 0.267,
        gain: expect.closeTo(10 ** (-13 / 20), 10),
        duration: 0.23,
      },
      {
        id: "click-b",
        file: "assets/sounds/mouse-click-trimmed.wav",
        at: 0.881,
        gain: expect.closeTo(0.22387, 4),
        duration: 0.23,
      },
    ]);
  });

  it("uses the item's own gain over the preset's", () => {
    const [hit] = soundHits(withClicks(-6), transcript, ISSEBYA_PRESET);
    expect(hit?.gain).toBeCloseTo(10 ** (-6 / 20), 10);
  });

  it("gives nothing for an edit without sounds", () => {
    const parsed = parseEdit(baselineJson, ISSEBYA_PRESET, transcript);
    if (!parsed.ok) throw new Error("fixture");
    expect(soundHits(parsed.edit, transcript, ISSEBYA_PRESET)).toEqual([]);
  });
});

describe("scheduleAt", () => {
  const hits: SoundHit[] = [
    { id: "click-a", file: "f", at: 0.267, gain: 1, duration: 0.23 },
    { id: "click-b", file: "f", at: 0.881, gain: 1, duration: 0.23 },
  ];

  it("schedules every hit from playhead 0", () => {
    const starts = scheduleAt(hits, 0, 10);
    expect(starts.map((s) => s.id)).toEqual(["click-a", "click-b"]);
    expect(starts[0]?.when).toBeCloseTo(10.267, 9);
    expect(starts[1]?.when).toBeCloseTo(10.881, 9);
    expect(starts.every((s) => s.offset === 0)).toBe(true);
  });

  it("skips a hit already over and keeps the later one from mid-reel", () => {
    const starts = scheduleAt(hits, 0.6, 2);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.id).toBe("click-b");
    expect(starts[0]?.when).toBeCloseTo(2.281, 9);
  });

  it("starts a hit in progress now, part way in", () => {
    const starts = scheduleAt(hits, 0.367, 5);
    expect(starts[0]).toEqual({ id: "click-a", when: 5, offset: expect.closeTo(0.1, 9) });
    expect(starts[1]?.id).toBe("click-b");
  });
});
