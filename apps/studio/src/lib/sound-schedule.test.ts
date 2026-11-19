import {
  ISSEBYA_PRESET,
  type Edit,
  parseEdit,
  resolveTimeline,
  soundCues,
  transcriptSchema,
} from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import transcriptJson from "../../../../fixtures/pipeline/retime/transcript.json" with { type: "json" };
import hookJson from "../../../../packages/edit/src/testdata/versions/baseline-short-speech-hook.edit.json" with { type: "json" };
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
        at: 0.324,
        // The click at the preset's -6 dB, the same as the export's data-volume.
        gain: expect.closeTo(10 ** (-6 / 20), 10),
        duration: 0.23,
      },
      {
        id: "click-b",
        file: "assets/sounds/mouse-click-trimmed.wav",
        at: 0.838,
        gain: expect.closeTo(0.50119, 4),
        duration: 0.23,
      },
    ]);
  });

  it("plays a visual's cue as the pop, as the builder does", () => {
    const edit = withClicks();
    // The first click becomes the cue of a card that comes in on the same word.
    edit.tracks.sounds[0]!.id = "click-visual-1";
    edit.tracks.behind = [
      {
        id: "visual-1",
        kind: "visual",
        box: { x: 90, y: 300, width: 360, height: 460 },
        start: { word: "w0002" },
        end: { word: "w0002", offset: 0.2 },
      },
    ];
    const hits = soundHits(edit, transcript, ISSEBYA_PRESET);
    expect(hits[0]).toEqual({
      id: "click-visual-1",
      file: "assets/sounds/pop.wav",
      at: 0.324,
      gain: expect.closeTo(10 ** (-6 / 20), 10),
      duration: 0.152,
    });
    // Any other sound stays the click.
    expect(hits[1]?.file).toBe("assets/sounds/mouse-click-trimmed.wav");
  });

  it("plays a big word's cue as the pop, at the click's time and gain", () => {
    const edit = withClicks();
    const click = soundHits(edit, transcript, ISSEBYA_PRESET)[0]!;
    // The first click becomes the cue of a big word that comes in on the same word.
    edit.tracks.sounds[0]!.id = "click-big-word-1";
    edit.tracks.behind = [
      {
        id: "big-word-1",
        kind: "word",
        text: "WORK",
        start: { word: "w0002" },
        end: { word: "w0002", offset: 0.2 },
      },
    ];
    const hits = soundHits(edit, transcript, ISSEBYA_PRESET);
    expect(hits[0]).toEqual({
      id: "click-big-word-1",
      file: "assets/sounds/pop.wav",
      at: click.at,
      gain: click.gain,
      duration: 0.152,
    });
    expect(hits[1]?.file).toBe("assets/sounds/mouse-click-trimmed.wav");
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

describe("soundHits, the typed hook", () => {
  const hook = () => {
    const parsed = parseEdit(hookJson, ISSEBYA_PRESET, transcript);
    if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
    return parsed.edit;
  };

  it("gives one hit per key sound, in step with the hook's letters, its gain set against the voice", () => {
    const hits = soundHits(hook(), transcript, ISSEBYA_PRESET);
    // The transcript holds the reel's measured voice, and the hits are set
    // against it (8 dB under the voice where the hook is typed, under its
    // ceilings): the builder's own number for each.
    expect(transcript.voice).toBeDefined();
    const edit = hook();
    const [first] = soundCues(
      edit,
      resolveTimeline(edit, transcript),
      ISSEBYA_PRESET,
      transcript.voice,
    );
    // "A short test for the real studio" from 0.2 s to the reel's end
    // (2.667 s): typed until 1.68 s, a hit on every second letter.
    expect(hits).toHaveLength(13);
    expect(hits[0]).toEqual({
      id: "hook_k1",
      file: "assets/sounds/typing-key-1.wav",
      at: 0.2,
      gain: first!.volume,
      duration: 0.07,
    });
    expect(hits[0]!.gain).toBeGreaterThan(0.2);
    expect(hits.at(-1)!.at).toBeLessThanOrEqual(1.68);
    expect(new Set(hits.map((hit) => hit.file)).size).toBe(4);
  });

  it("plays exactly the clips the builder writes for the export, one hit a clip", () => {
    const edit = hook();
    const cues = soundCues(
      edit,
      resolveTimeline(edit, transcript),
      ISSEBYA_PRESET,
      transcript.voice,
    );
    const hits = soundHits(edit, transcript, ISSEBYA_PRESET);
    expect(hits.map((hit) => [hit.id, hit.at, hit.duration])).toEqual(
      cues.map((cue) => [cue.id, cue.at, cue.duration]),
    );
    // The same gain as the export's clip, to the digit: the number the builder
    // writes as `data-volume`.
    expect(hits.map((hit) => hit.gain.toFixed(4))).toEqual(
      cues.map((cue) => cue.volume.toFixed(4)),
    );
    expect(hits.map((hit) => hit.gain)).toEqual(cues.map((cue) => cue.volume));
  });

  it("plays the assumed voice's gain for a version whose transcript holds no measure", () => {
    const edit = hook();
    const hits = soundHits(edit, { words: transcript.words }, ISSEBYA_PRESET);
    expect(hits).toHaveLength(13);
    expect(hits.every((hit) => hit.gain === 0.5827)).toBe(true);
  });

  it("starts the typing part way in when playback starts in the middle of it", () => {
    const hits = soundHits(hook(), transcript, ISSEBYA_PRESET);
    const starts = scheduleAt(hits, 1, 5);
    // Hits already over are skipped; the rest keep their distance to the playhead.
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.length).toBeLessThan(hits.length);
    for (const start of starts) {
      const hit = hits.find((entry) => entry.id === start.id)!;
      expect(hit.at + hit.duration).toBeGreaterThan(1);
      if (hit.at >= 1) expect(start.when).toBeCloseTo(5 + hit.at - 1, 9);
      // Each start carries the gain it is played at: the hit's, the clip's.
      expect(start.gain).toBe(hit.gain);
    }
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
    expect(starts[0]).toEqual({
      id: "click-a",
      when: 5,
      offset: expect.closeTo(0.1, 9),
      gain: 1,
    });
    expect(starts[1]?.id).toBe("click-b");
  });
});
