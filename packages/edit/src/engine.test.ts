import { describe, expect, it } from "vitest";
import { type Backgrounds, backgroundSampler } from "./background.ts";
import { maskSpans } from "./behind.ts";
import { build } from "./build.ts";
import { editFromAnswer } from "./decide.ts";
import { placeEdit } from "./engine.ts";
import type { EngineInput } from "./engine-input.ts";
import { type HeadTrack, facesOver } from "./head-track.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { backgroundMapOf } from "./test-support/backgrounds.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { resolveTimeline } from "./timeline.ts";
import { sentenceSpans } from "./transcript.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const { transcript } = hand;
const words = transcript.words;
const byId = new Map(words.map((word) => [word.id, word]));
const sentences = sentenceSpans(transcript);
const PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";
const OTHER_PHOTO = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";

const NOTHING: EngineInput = {
  accents: [],
  big_word: null,
  photos: [],
  transitions: [],
  word_fixes: [],
};

// A steady head (with a little jitter) for the whole 50 s reel.
function steadyHead(sample: { head_top: number; cx: number; head_w: number }): HeadTrack {
  return Array.from({ length: 200 }, (_, index) => ({
    t: index * 0.25,
    head_top: sample.head_top + (index % 3) * 4,
    cx: sample.cx + (index % 2) * 6,
    head_w: sample.head_w,
  }));
}

// The large, centred face of the reel the decide failures were on (face box
// x 434 to 726, y 452 to 846).
const BIG_FACE = steadyHead({ head_top: 452, cx: 580, head_w: 292 });

function withPlaceholderMasks(edit: Edit): Edit {
  const masks = maskSpans(edit, transcript, ISSEBYA_PRESET).map((span, index) => ({
    step: "cutout" as const,
    fingerprint: String(index + 1).repeat(64),
    file: "mask.mp4",
    start: span.start,
    end: span.end,
  }));
  return { ...edit, inputs: { ...edit.inputs, ...(masks.length > 0 ? { masks } : {}) } };
}

async function place(
  input: Partial<EngineInput>,
  {
    headTrack = hand.headTrack,
    current = hand.edit,
    backgrounds,
  }: { headTrack?: HeadTrack; current?: Edit; backgrounds?: Backgrounds } = {},
) {
  const measurer = await nodeMeasurer();
  const made = editFromAnswer(
    current,
    { ...NOTHING, ...input },
    ISSEBYA_PRESET,
    transcript,
    headTrack,
    measurer,
    backgrounds,
  );
  if (!made.ok) throw new Error(made.reasons.join("; "));
  const { checks } = build(
    withPlaceholderMasks(made.edit),
    transcript,
    headTrack,
    ISSEBYA_PRESET,
    measurer,
  );
  return {
    edit: made.edit,
    record: made.record,
    checks,
    spans: resolveTimeline(made.edit, transcript),
  };
}

const extrasOf = (edit: Edit) => [...edit.tracks.overlays, ...(edit.tracks.behind ?? [])];

describe("the layout engine's timing", () => {
  it("shows each caption from its word, the group until its last word or 0.25 s, never into the next group", async () => {
    const { edit, spans, record } = await place({});
    const captions = edit.tracks.captions;
    for (const [index, caption] of captions.entries()) {
      const span = spans.get(caption.id)!;
      expect(span.start).toBe(byId.get(caption.words[0]!)!.start);
      expect(span.end - span.start).toBeGreaterThanOrEqual(
        ISSEBYA_PRESET.caption.minSeconds - 1e-6,
      );
      const next = captions
        .slice(index + 1)
        .find((c) => JSON.stringify(c.end) !== JSON.stringify(caption.end));
      if (next) expect(span.end).toBeLessThanOrEqual(spans.get(next.id)!.start + 1e-6);
    }
    // "to" (0.09 s before the next group) joins the next group, recorded.
    expect(record).toContainEqual({
      item: "cw94",
      action: "retimed",
      rule: "caption-min",
      reason: 'caption "to" joins the next group, so it shows at least 0.25 s',
    });
  });

  it("shows an accent from its first word to a second after its last, at least 1.5 s", async () => {
    const { spans } = await place({
      accents: [
        { from: "w29", to: "w29", title: false },
        { from: "w84", to: "w87", title: false },
      ],
    });
    const one = spans.get("accent-1")!;
    expect(one.start).toBe(byId.get("w29")!.start);
    expect(one.end - one.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
    const two = spans.get("accent-2")!;
    expect(two.start).toBe(byId.get("w84")!.start);
    expect(two.end).toBeCloseTo(byId.get("w87")!.end + 1, 3);
  });

  it("cuts an accent short when the next one needs the space, and records it", async () => {
    const { spans, record } = await place({
      accents: [
        { from: "w26", to: "w29", title: false },
        { from: "w31", to: "w33", title: false },
      ],
    });
    const one = spans.get("accent-1")!;
    const two = spans.get("accent-2")!;
    expect(one.end).toBeLessThanOrEqual(two.start + 1e-6);
    expect(one.end - one.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
    expect(record).toContainEqual(
      expect.objectContaining({ item: "accent-1", action: "retimed", rule: "one-extra" }),
    );
  });

  it("shows the big word exactly on its word to the end of its sentence, 2 to 4 s", async () => {
    const { spans, edit } = await place({ big_word: { word: "w76" } });
    const span = spans.get("big-word")!;
    expect(span.start).toBe(byId.get("w76")!.start);
    const sentence = sentences.find((s) => s.from === "w63")!;
    expect(span.end).toBeCloseTo(Math.min(sentence.end, span.start + 4), 3);
    expect(edit.tracks.behind![0]).toMatchObject({ kind: "word", text: "distribution" });
  });

  it("shows a photo over its sentence, 2 to 4 s, never into the next sentence", async () => {
    // "We have it all." and its pauses last 0.9 s: the photo would cross
    // into another sentence, so it is dropped.
    const short = await place({ photos: [{ photo_id: PHOTO, from: "w113", to: "w116" }] });
    expect(short.edit.tracks.behind).toBeUndefined();
    expect(short.record).toContainEqual(
      expect.objectContaining({ item: "photo-1", action: "dropped", rule: "photo-time" }),
    );
    // A sentence of 3.2 s: from its start to its end.
    const whole = await place({ photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }] });
    const span = whole.spans.get("photo-1")!;
    const sentence = sentences.find((s) => s.from === "w84")!;
    expect(span.start).toBe(sentence.start);
    expect(span.end).toBeCloseTo(sentence.end, 3);
    // A long sentence, photo words late in it: from its first word, 4 s.
    const late = await place({ photos: [{ photo_id: PHOTO, from: "w18", to: "w25" }] });
    const lateSpan = late.spans.get("photo-1")!;
    expect(lateSpan.start).toBe(byId.get("w18")!.start);
    expect(lateSpan.end).toBeLessThanOrEqual(sentences[0]!.end + 1e-6);
  });

  it("drops a title too long for two lines at the smallest size, with the reason", async () => {
    const { edit, record } = await place(
      { accents: [{ from: "w63", to: "w71", title: true }] },
      { headTrack: BIG_FACE },
    );
    expect(edit.tracks.overlays).toEqual([]);
    expect(record).toContainEqual(
      expect.objectContaining({ item: "title", action: "dropped", rule: "no-room" }),
    );
  });

  it("drops what cannot last its minimum, with the reason", async () => {
    const lastWord = words.at(-1)!;
    const { edit, record } = await place({
      accents: [{ from: lastWord.id, to: lastWord.id, title: false }],
    });
    expect(edit.tracks.overlays).toEqual([]);
    expect(record).toContainEqual(
      expect.objectContaining({ item: "accent-1", action: "dropped", rule: "accent-time" }),
    );
  });

  it("shows at most one extra at a time, by priority", async () => {
    const { edit, spans, record } = await place({
      accents: [{ from: "w66", to: "w67", title: false }],
      big_word: { word: "w66" },
      photos: [{ photo_id: PHOTO, from: "w63", to: "w70" }],
    });
    const extras = extrasOf(edit).map((item) => spans.get(item.id)!);
    for (const [index, a] of extras.entries()) {
      for (const b of extras.slice(index + 1)) {
        expect(a.end <= b.start + 1e-6 || b.end <= a.start + 1e-6).toBe(true);
      }
    }
    // The accent comes first; the big word on the same word cannot wait.
    expect(edit.tracks.overlays.map((item) => item.id)).toEqual(["accent-1"]);
    expect(record).toContainEqual(
      expect.objectContaining({ item: "big-word", action: "dropped", rule: "one-extra" }),
    );
  });

  it("places the items the request is about before the other extras", async () => {
    const measurer = await nodeMeasurer();
    const input: EngineInput = {
      ...NOTHING,
      accents: [{ from: "w66", to: "w67", title: false }],
      big_word: { word: "w66" },
    };
    const asked = placeEdit(
      hand.edit,
      input,
      transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      measurer,
      {
        requested: ["big_word"],
      },
    );
    expect(asked.tracks.behind?.map((item) => item.id)).toEqual(["big-word"]);
    expect(asked.tracks.overlays).toEqual([]);
  });
});

describe("the layout engine's placement", () => {
  // Every sentence's first words as an accent, one big word, two photos and a
  // transition over one reel.
  const DENSE: Partial<EngineInput> = {
    accents: [
      { from: "w0", to: "w4", title: true },
      { from: "w26", to: "w28", title: false },
      { from: "w100", to: "w102", title: false },
      { from: "w117", to: "w120", title: false },
      { from: "w134", to: "w136", title: false },
    ],
    big_word: { word: "w76" },
    photos: [
      { photo_id: PHOTO, from: "w84", to: "w99" },
      { photo_id: OTHER_PHOTO, from: "w113", to: "w116" },
    ],
    transitions: [{ kind: "panel", from: "w126", to: "w133" }],
  };

  for (const [name, headTrack] of [
    ["the real head", hand.headTrack],
    ["a large centred face", BIG_FACE],
  ] as const) {
    it(`never overlaps anything on a dense reel with ${name}: every check passes`, async () => {
      const { checks } = await place(DENSE, { headTrack });
      expect(checks).toEqual([]);
    });
  }

  it("keeps one spot for a whole sentence: each group starts at the same place", async () => {
    const { edit, spans } = await place({}, { headTrack: BIG_FACE });
    for (const sentence of sentences) {
      const from = words.findIndex((word) => word.id === sentence.from);
      const to = words.findIndex((word) => word.id === sentence.to);
      const ids = new Set(words.slice(from, to + 1).map((word) => word.id));
      const captions = edit.tracks.captions.filter((caption) => ids.has(caption.words[0]!));
      const groups = new Map<string, number[]>();
      for (const caption of captions) {
        const key = String(spans.get(caption.id)!.end);
        groups.set(key, [...(groups.get(key) ?? []), caption.position!.y]);
      }
      const tops = new Set([...groups.values()].map((ys) => Math.min(...ys)));
      expect(tops.size).toBe(1);
    }
  });

  it("sets the big word on its word and inside the frame with one bad head reading", async () => {
    const at = byId.get("w76")!.start;
    // One reading at the big word's start puts the head at the frame's top.
    const glitch = hand.headTrack.map((sample) =>
      sample && Math.abs(sample.t - at) < 0.13 ? { ...sample, head_top: 0 } : sample,
    );
    const { edit, spans, checks } = await place(
      { big_word: { word: "w76" } },
      { headTrack: glitch },
    );
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    expect(spans.get(word.id)!.start).toBe(at);
    if (word.kind !== "word") throw new Error("not a word");
    expect(word.position!.y).toBeGreaterThan(300);
    expect(checks).toEqual([]);
    // The robust face ignores the reading.
    expect(facesOver(glitch, at, at)[0]!.top).toBeGreaterThan(300);
  });

  it("shrinks or wraps a title wider than the frame to fit the safe zone", async () => {
    // "social media has given us" is about 1400 px at 110 px, the frame 1080.
    const { edit, record, checks } = await place(
      { accents: [{ from: "w63", to: "w67", title: true }] },
      { headTrack: BIG_FACE },
    );
    const title = edit.tracks.overlays[0]!;
    expect(title.id).toBe("title");
    expect(title.break_after).toBeGreaterThan(0);
    expect(title.size).toBeLessThan(110);
    expect(record.filter((note) => note.item === "title").map((note) => note.action)).toEqual(
      expect.arrayContaining(["shrunk", "wrapped"]),
    );
    expect(checks).toEqual([]);
  });

  it("is deterministic: the same input gives the same edit and record", async () => {
    const one = await place({ ...DENSE }, { headTrack: BIG_FACE });
    const two = await place({ ...DENSE }, { headTrack: BIG_FACE });
    expect(two.edit).toEqual(one.edit);
    expect(two.record).toEqual(one.record);
  });

  it("places its own output again exactly the same", async () => {
    const one = await place(DENSE);
    const again = editFromAnswer(
      one.edit,
      { ...NOTHING, ...DENSE },
      ISSEBYA_PRESET,
      transcript,
      hand.headTrack,
      await nodeMeasurer(),
    );
    if (!again.ok) throw new Error(again.reasons.join("; "));
    expect(again.edit.tracks).toEqual(one.edit.tracks);
  });

  it("puts captions over the face only when nothing else is free, and records it", async () => {
    // A face filling the whole safe zone.
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const { edit, record } = await place({}, { headTrack: huge });
    expect(edit.tracks.captions.every((caption) => caption.position !== undefined)).toBe(true);
    expect(record.some((note) => note.action === "covers-face")).toBe(true);
  });
});

describe("today's failures, placed by the engine", () => {
  it('two accents in a row never overlap ("Keep trying" on "experiments")', async () => {
    const { checks, spans } = await place(
      {
        accents: [
          { from: "w26", to: "w28", title: false },
          { from: "w29", to: "w29", title: false },
        ],
      },
      { headTrack: BIG_FACE },
    );
    expect(checks).toEqual([]);
    const one = spans.get("accent-1")!;
    const two = spans.get("accent-2");
    if (two) expect(one.end).toBeLessThanOrEqual(two.start + 1e-6);
  });

  it("keeps the captions off the big word", async () => {
    const { checks, edit } = await place({ big_word: { word: "w76" } }, { headTrack: BIG_FACE });
    expect(edit.tracks.behind).toHaveLength(1);
    expect(checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
  });

  it("keeps card captions off the face", async () => {
    const { checks, edit } = await place(
      { transitions: [{ kind: "card", from: "w84", to: "w99" }] },
      { headTrack: BIG_FACE },
    );
    expect(edit.tracks.transitions).toHaveLength(1);
    expect(checks).toEqual([]);
  });

  it("keeps a photo spot free of captions on its sentence", async () => {
    // The question sentence the v4 photo was dropped from, on the large face.
    const { edit, checks, record } = await place(
      { photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }] },
      { headTrack: BIG_FACE },
    );
    expect(edit.tracks.behind).toEqual([expect.objectContaining({ id: "photo-1", kind: "photo" })]);
    expect(checks).toEqual([]);
    expect(record.filter((note) => note.action === "dropped")).toEqual([]);
  });

  it("drops a photo with a recorded reason when the face takes every spot", async () => {
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const { edit, record } = await place(
      { photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }] },
      { headTrack: huge },
    );
    expect(edit.tracks.behind).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({ item: "photo-1", action: "dropped", rule: "no-room" }),
    );
  });
});

describe("readable text", () => {
  const FRAME = ISSEBYA_PRESET.frame;
  const BEIGE = "#D8C3A5";
  const DARK = "#101010";
  // A sampled map of the whole reel: `paint` gives each cell's colour.
  const mapOf = (paint: (x: number, y: number, t: number) => string) =>
    backgroundSampler(backgroundMapOf(FRAME, hand.edit.duration, paint), FRAME);
  const inside = (
    x: number,
    y: number,
    box: { left: number; right: number; top: number; bottom: number },
  ) => x >= box.left && x < box.right && y >= box.top && y < box.bottom;
  const ACCENT: Partial<EngineInput> = { accents: [{ from: "w84", to: "w87", title: false }] };

  it("moves a caption block on a light band to a darker free place in its zone", async () => {
    const before = await place({});
    const first = before.edit.tracks.captions[0]!;
    // A light band across the frame where the first sentence's captions sit.
    const band = {
      left: 0,
      right: FRAME.width,
      top: first.position!.y - 10,
      bottom: first.position!.y + first.size! + 10,
    };
    const backgrounds = mapOf((x, y) => (inside(x, y, band) ? BEIGE : DARK));
    const { edit, record, checks } = await place({}, { backgrounds });
    const moved = edit.tracks.captions[0]!;
    expect(moved.position).not.toEqual(first.position);
    expect(moved.shadow).toBeUndefined();
    expect(moved.color).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({ item: first.id, action: "moved", rule: "contrast-spot" }),
    );
    const note = record.find((entry) => entry.rule === "contrast-spot")!;
    expect(note.reason).toMatch(
      /^captions ".+" moves \d+ px to a free place it reads on: contrast 1\.\d:1 from \d+\.\d\d s to \d+\.\d\d s, under 4\.5:1, now \d+\.\d:1$/,
    );
    expect(record.filter((entry) => entry.action === "shadowed")).toEqual([]);
    expect(checks).toEqual([]);
  });

  it("keeps the place and adds a shadow when no free place nearby reads, level by the ratio", async () => {
    const before = await place({});
    for (const [color, level] of [
      [BEIGE, 2],
      ["#8A8A8A", 1],
    ] as const) {
      const { edit, record, checks } = await place({}, { backgrounds: mapOf(() => color) });
      expect(edit.tracks.captions.map((caption) => caption.position)).toEqual(
        before.edit.tracks.captions.map((caption) => caption.position),
      );
      for (const caption of edit.tracks.captions) {
        expect(caption.shadow).toBe(level);
        expect(caption.color).toBeUndefined();
      }
      const notes = record.filter((entry) => entry.rule === "contrast-shadow");
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0]!.action).toBe("shadowed");
      expect(notes[0]!.reason).toContain(`gets a soft shadow (level ${level}): contrast `);
      expect(notes[0]!.reason).toMatch(/ \d\.\d:1 from .* no free place nearby reaches 4\.5:1$/);
      expect(record.filter((entry) => entry.rule === "contrast-spot")).toEqual([]);
      expect(checks).toEqual([]);
    }
  });

  it("moves the accent off a beige sweater when its zone has a darker free area", async () => {
    // No head: the accent's zone is the whole safe zone, room to move.
    const headTrack: HeadTrack = [];
    const before = await place(ACCENT, { headTrack });
    const accent = before.edit.tracks.overlays[0]!;
    // The sweater: a beige band across the frame where the accent first sits.
    const band = {
      left: 0,
      right: FRAME.width,
      top: accent.position!.y - 10,
      bottom: accent.position!.y + accent.size! + 10,
    };
    const backgrounds = mapOf((x, y) => (inside(x, y, band) ? BEIGE : DARK));
    const { edit, record, checks } = await place(ACCENT, { backgrounds, headTrack });
    const moved = edit.tracks.overlays[0]!;
    expect(moved.position).not.toEqual(accent.position);
    expect(moved.shadow).toBeUndefined();
    expect(moved.color).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({ item: "accent-1", action: "moved", rule: "contrast-spot" }),
    );
    expect(checks).toEqual([]);
  });

  it("gives the accent a strong shadow when beige is all around, never a colour", async () => {
    const before = await place(ACCENT);
    const { edit, record } = await place(ACCENT, { backgrounds: mapOf(() => BEIGE) });
    const accent = edit.tracks.overlays[0]!;
    expect(accent.position).toEqual(before.edit.tracks.overlays[0]!.position);
    expect(accent.shadow).toBe(2);
    expect(accent.color).toBeUndefined();
    expect(record).toContainEqual({
      item: "accent-1",
      action: "shadowed",
      rule: "contrast-shadow",
      reason: expect.stringMatching(
        /^accent ".+" gets a soft shadow \(level 2\): contrast 1\.2:1 from \d+\.\d\d s to \d+\.\d\d s, no free place nearby reaches 3:1$/,
      ),
    });
  });

  it("shadows the big word on a light background and never moves it", async () => {
    const input = { big_word: { word: "w76" } };
    const before = await place(input);
    const { edit, record } = await place(input, { backgrounds: mapOf(() => BEIGE) });
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    const was = before.edit.tracks.behind!.find((item) => item.kind === "word")!;
    if (word.kind !== "word" || was.kind !== "word") throw new Error("not a word");
    expect(word.position).toEqual(was.position);
    expect(word.shadow).toBe(2);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "big-word",
        action: "shadowed",
        rule: "contrast-shadow",
        reason: expect.stringMatching(/the big word is never moved$/),
      }),
    );
    expect(record.filter((entry) => entry.item === "big-word" && entry.action === "moved")).toEqual(
      [],
    );
  });

  it("changes nothing on a dark background: the same edit and record as with no map", async () => {
    const input = { ...ACCENT, big_word: { word: "w76" } };
    const none = await place(input);
    const dark = await place(input, { backgrounds: mapOf(() => DARK) });
    expect(dark.edit).toEqual(none.edit);
    expect(dark.record).toEqual(none.record);
  });

  it("is deterministic over a map", async () => {
    const backgrounds = mapOf((x, y) => (x < 540 === y < 960 ? BEIGE : DARK));
    const one = await place(ACCENT, { backgrounds });
    const two = await place(ACCENT, { backgrounds });
    expect(two.edit).toEqual(one.edit);
    expect(two.record).toEqual(one.record);
  });

  it("never measures captions inside a transition", async () => {
    const input: Partial<EngineInput> = {
      transitions: [{ kind: "panel", from: "w126", to: "w133" }],
    };
    const { edit, spans } = await place(input, { backgrounds: mapOf(() => "#FFFFFF") });
    const transition = spans.get("transition-1")!;
    const insideTransition = edit.tracks.captions.filter((caption) => {
      const start = spans.get(caption.id)!.start;
      return start >= transition.start - 1e-6 && start < transition.end - 1e-6;
    });
    expect(insideTransition.length).toBeGreaterThan(0);
    for (const caption of insideTransition) expect(caption.shadow).toBeUndefined();
    const outside = edit.tracks.captions.filter((caption) => !insideTransition.includes(caption));
    for (const caption of outside) expect(caption.shadow).toBe(2);
  });
});
