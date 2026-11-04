import { describe, expect, it } from "vitest";
import { type Backgrounds, backgroundSampler } from "./background.ts";
import { maskSpans } from "./behind.ts";
import { build } from "./build.ts";
import { editFromAnswer } from "./decide.ts";
import { placeEdit } from "./engine.ts";
import type { EngineInput } from "./engine-input.ts";
import { type HeadTrack, facesOver } from "./head-track.ts";
import { ISSEBYA_PRESET, PLATFORM_BUTTONS, PLATFORM_SAFE, TRANSITION_KINDS } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { backgroundMapOf } from "./test-support/backgrounds.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { LEFT_HEAD, REQUEST_ANSWER, REQUEST_PHOTO } from "./test-support/request.ts";
import { resolveTimeline } from "./timeline.ts";
import { type Transcript, sentenceSpans } from "./transcript.ts";
import { levelBoxes } from "./transitions.ts";

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
    requested,
  }: {
    headTrack?: HeadTrack;
    current?: Edit;
    backgrounds?: Backgrounds;
    // The answer refs the request's checklist links.
    requested?: string[];
  } = {},
) {
  const measurer = await nodeMeasurer();
  const made = editFromAnswer(
    current,
    {
      ...NOTHING,
      ...input,
      ...(requested ? { checklist: [{ fulfilled_by: requested }] } : {}),
    },
    ISSEBYA_PRESET,
    transcript,
    headTrack,
    measurer,
    backgrounds,
  );
  if (!made.ok) throw new Error(made.reasons.join("; "));
  const { checks, html } = build(
    withPlaceholderMasks(made.edit),
    transcript,
    headTrack,
    ISSEBYA_PRESET,
    measurer,
  );
  const spans = resolveTimeline(made.edit, transcript);
  return {
    edit: made.edit,
    record: made.record,
    unplaced: made.unplaced,
    free: made.free,
    checks,
    html,
    spans,
    levels: levelBoxes(made.edit, spans, byId, ISSEBYA_PRESET, measurer),
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
    transitions: [{ kind: "panel", from: "w126", to: "w133", key_from: "w128" }],
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

  it("keeps a dim's text levels off the face", async () => {
    const { checks, edit, levels } = await place(
      { transitions: [{ kind: "dim", from: "w84", to: "w99", key_from: "w91" }] },
      { headTrack: BIG_FACE },
    );
    expect(edit.tracks.transitions).toHaveLength(1);
    expect(levels.map((level) => level.role)).toEqual(["lead", "key"]);
    for (const level of levels) {
      for (const face of facesOver(BIG_FACE, level.start, level.end)) {
        const clear =
          level.x + level.width <= face.left ||
          level.x >= face.right ||
          level.y + level.height <= face.top ||
          level.y >= face.bottom;
        expect(clear).toBe(true);
      }
    }
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

  it("never measures a transition's levels: they sit on its layer", async () => {
    const input: Partial<EngineInput> = {
      transitions: [{ kind: "panel", from: "w126", to: "w133", key_from: "w128" }],
    };
    const { edit, record } = await place(input, { backgrounds: mapOf(() => "#FFFFFF") });
    const [transition] = edit.tracks.transitions;
    expect(transition!.levels).toBeDefined();
    // Its phrase's captions show only as its levels: no place, no shadow.
    const phrase = new Set(transition!.words);
    const inside = edit.tracks.captions.filter((caption) => phrase.has(caption.words[0]!));
    expect(inside.length).toBeGreaterThan(0);
    for (const caption of inside) {
      expect(caption.position).toBeUndefined();
      expect(caption.shadow).toBeUndefined();
    }
    const outside = edit.tracks.captions.filter((caption) => !inside.includes(caption));
    for (const caption of outside) expect(caption.shadow).toBe(2);
    expect(
      record.filter((note) => note.item === "transition-1" && note.rule.startsWith("contrast")),
    ).toEqual([]);
  });
});

// The reference reel with `seconds` of silence inserted after a word: every
// later word, and the reel's end, `seconds` later.
function withPause(after: string, seconds: number): { transcript: Transcript; edit: Edit } {
  const at = words.findIndex((word) => word.id === after);
  const shifted = {
    ...transcript,
    words: words.map((word, index) =>
      index <= at ? word : { ...word, start: word.start + seconds, end: word.end + seconds },
    ),
  };
  return { transcript: shifted, edit: { ...hand.edit, duration: hand.edit.duration + seconds } };
}

describe("transitions", () => {
  const T = ISSEBYA_PRESET.transition;
  const DIM = { kind: "dim" as const, from: "w26", to: "w33", key_from: "w30" };
  const start = (id: string) => byId.get(id)!.start;
  const end = (id: string) => byId.get(id)!.end;
  const ms = (t: number) => Math.round(t * 1000) / 1000;

  it("comes in as its phrase's first word starts and has left when the next word starts", async () => {
    const { spans, levels, edit, html, checks } = await place({ transitions: [DIM] });
    const span = spans.get("transition-1")!;
    // The fade (0.3 s) finishes as w26 starts; gone as w34 starts.
    expect(span.start).toBe(ms(start("w26") - ISSEBYA_PRESET.transitions.dim.seconds));
    expect(span.end).toBe(start("w34"));
    expect(edit.tracks.transitions[0]).toMatchObject({
      type: "dim",
      words: ["w26", "w27", "w28", "w29", "w30", "w31", "w32", "w33"],
      key: "w30",
    });
    // Each level appears whole on its first word and stays until it leaves.
    const lead = levels.find((level) => level.role === "lead")!;
    const key = levels.find((level) => level.role === "key")!;
    expect(lead.start).toBe(start("w26"));
    expect(key.start).toBe(start("w30"));
    expect([lead.end, key.end]).toEqual([span.end, span.end]);
    expect(lead.text).toBe("AI has completely disrupted");
    expect(key.text).toBe("the way we work");
    // Its phrase's captions show nowhere else.
    for (const id of ["cw26", "cw30", "cw33"]) {
      expect(edit.tracks.captions.find((caption) => caption.id === id)!.position).toBeUndefined();
      expect(html).not.toContain(`id="${id}"`);
    }
    expect(html).toContain('id="transition-1-lead"');
    expect(checks).toEqual([]);
  });

  it("holds 1 s after its phrase before a long pause, 2 s when asked longer", async () => {
    const paused = withPause("w33", 3);
    const measurer = await nodeMeasurer();
    const spanOf = async (wish?: "long" | "slow") => {
      const made = editFromAnswer(
        paused.edit,
        { ...NOTHING, transitions: [{ ...DIM, ...(wish ? { wish } : {}) }] },
        ISSEBYA_PRESET,
        paused.transcript,
        hand.headTrack,
        measurer,
      );
      if (!made.ok) throw new Error(made.reasons.join("; "));
      return {
        span: resolveTimeline(made.edit, paused.transcript).get("transition-1")!,
        item: made.edit.tracks.transitions[0]!,
      };
    };
    const plain = await spanOf();
    expect(plain.span.end).toBe(ms(end("w33") + T.holdSeconds));
    const long = await spanOf("long");
    expect(long.span.end).toBe(ms(end("w33") + T.longHoldSeconds));
    expect(long.item.hold).toBe("long");
    // Slower: the motion 1.6 times as long, still finishing on the first word.
    const slow = await spanOf("slow");
    expect(slow.span.start).toBe(
      ms(start("w26") - ISSEBYA_PRESET.transitions.dim.seconds * T.slowFactor),
    );
    expect(slow.item.pace).toBe("slow");
  });

  it("lasts at least 1.5 s: a two-word phrase is lengthened, recorded", async () => {
    const { spans, record, checks } = await place({
      transitions: [{ kind: "dim", from: "w26", to: "w27", key_from: "w26" }],
    });
    const span = spans.get("transition-1")!;
    expect(span.end - span.start).toBeGreaterThanOrEqual(T.minSeconds - 1e-6);
    expect(record).toContainEqual(
      expect.objectContaining({ item: "transition-1", action: "retimed", rule: "transition-min" }),
    );
    expect(checks).toEqual([]);
  });

  it("sets the lead-in in caption text and the key phrase in accent text, inside its area and the safe zone", async () => {
    for (const kind of TRANSITION_KINDS) {
      const { levels, checks } = await place(
        { transitions: [{ ...DIM, kind }] },
        { headTrack: BIG_FACE },
      );
      const area = ISSEBYA_PRESET.transitions[kind].area;
      const lead = levels.find((level) => level.role === "lead")!;
      const key = levels.find((level) => level.role === "key")!;
      expect([lead.font, lead.color]).toEqual([
        ISSEBYA_PRESET.caption.font,
        ISSEBYA_PRESET.caption.color,
      ]);
      expect([key.font, key.color]).toEqual([
        ISSEBYA_PRESET.accent.font,
        ISSEBYA_PRESET.accent.color,
      ]);
      for (const level of levels) {
        for (const box of [area, ISSEBYA_PRESET.safe, PLATFORM_SAFE]) {
          expect(level.x).toBeGreaterThanOrEqual(box.left - 1e-6);
          expect(level.x + level.width).toBeLessThanOrEqual(box.right + 1e-6);
          expect(level.y).toBeGreaterThanOrEqual(box.top - 1e-6);
          expect(level.y + level.height).toBeLessThanOrEqual(box.bottom + 1e-6);
        }
        if (level.y + level.height > PLATFORM_BUTTONS.top) {
          expect(level.x + level.width).toBeLessThanOrEqual(PLATFORM_BUTTONS.left);
        }
        for (const face of facesOver(BIG_FACE, level.start, level.end)) {
          const clear =
            level.x + level.width <= face.left ||
            level.x >= face.right ||
            level.y + level.height <= face.top ||
            level.y >= face.bottom;
          expect(clear).toBe(true);
        }
      }
      expect(checks).toEqual([]);
    }
  });

  it("covers the face only when the face fills its area, and records it", async () => {
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const { record, edit } = await place({ transitions: [DIM] }, { headTrack: huge });
    expect(edit.tracks.transitions).toHaveLength(1);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "transition-1",
        action: "covers-face",
        rule: "transition-face",
      }),
    );
  });

  it("keeps about one transition per 7 s: the eighth on a 47 s reel is dropped", async () => {
    const phrases = [
      ["w0", "w2"],
      ["w20", "w22"],
      ["w40", "w42"],
      ["w60", "w62"],
      ["w80", "w82"],
      ["w100", "w102"],
      ["w120", "w122"],
      ["w140", "w142"],
    ];
    const { edit, record } = await place({
      transitions: phrases.map(([from, to]) => ({
        kind: "dim" as const,
        from: from!,
        to: to!,
        key_from: from!,
      })),
    });
    const room = Math.max(1, Math.round(hand.edit.duration / T.perSeconds));
    expect(room).toBe(7);
    // The same kind repeats.
    expect(edit.tracks.transitions.map((item) => item.id)).toEqual([
      "transition-1",
      "transition-2",
      "transition-3",
      "transition-4",
      "transition-5",
      "transition-6",
      "transition-7",
    ]);
    expect(record).toContainEqual({
      item: "transition-8",
      action: "dropped",
      rule: "transition-rate",
      reason:
        'transition 8 (dim) on "life doesn\'t feel" dropped: about one transition per 7 s, this reel has room for 7',
    });
  });

  it("never shows two at once: the earlier leaves as the later comes in, or the later is dropped", async () => {
    // Back to back: the first item ends as the second comes in.
    const back = await place({
      transitions: [
        { kind: "numbered", from: "w106", to: "w108", key_from: "w107" },
        { kind: "numbered", from: "w109", to: "w112", key_from: "w110" },
      ],
    });
    const one = back.spans.get("transition-1")!;
    const two = back.spans.get("transition-2")!;
    expect(one.end).toBeLessThanOrEqual(two.start + 1e-6);
    expect(back.record).toContainEqual(
      expect.objectContaining({
        item: "transition-1",
        action: "retimed",
        rule: "transition-overlap",
      }),
    );
    // Overlapping phrases: the earlier would last under 1.5 s.
    const clash = await place({
      transitions: [DIM, { kind: "panel", from: "w30", to: "w40", key_from: "w34" }],
    });
    expect(clash.edit.tracks.transitions.map((item) => item.id)).toEqual(["transition-1"]);
    expect(clash.record).toContainEqual(
      expect.objectContaining({
        item: "transition-2",
        action: "dropped",
        rule: "transition-overlap",
      }),
    );
  });

  it("shows nothing else during a transition: an accent inside it is dropped", async () => {
    const { edit, record, checks } = await place({
      transitions: [DIM],
      accents: [{ from: "w30", to: "w31", title: false }],
    });
    expect(edit.tracks.overlays).toEqual([]);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "accent-1",
        action: "dropped",
        rule: "one-extra",
        reason: expect.stringContaining("while a transition is running from"),
      }),
    );
    expect(checks).toEqual([]);
  });

  it("ends an accent before a transition comes in", async () => {
    const { spans, edit } = await place({
      transitions: [DIM],
      accents: [{ from: "w17", to: "w18", title: false }],
    });
    expect(edit.tracks.overlays).toHaveLength(1);
    expect(spans.get("accent-1")!.end).toBeLessThanOrEqual(spans.get("transition-1")!.start + 1e-6);
  });

  it("numbers list items 1, 2, 3 in reel order, the number above the lead-in and the key phrase", async () => {
    const { edit, levels, checks } = await place({
      transitions: [
        { kind: "numbered", from: "w106", to: "w108", key_from: "w107" },
        { kind: "numbered", from: "w100", to: "w103", key_from: "w102" },
        { kind: "numbered", from: "w117", to: "w119", key_from: "w118" },
      ],
    });
    expect(edit.tracks.transitions.map((item) => [item.id, item.number])).toEqual([
      ["transition-1", 2],
      ["transition-2", 1],
      ["transition-3", 3],
    ]);
    for (const item of edit.tracks.transitions) {
      const own = levels.filter((level) => level.transitionId === item.id);
      expect(own.map((level) => level.role)).toEqual(["number", "lead", "key"]);
      expect(own[0]!.text).toBe(String(item.number));
      expect(own[0]!.size).toBeGreaterThan(own[2]!.size);
      expect(own[0]!.y).toBeLessThan(own[1]!.y);
      expect(own[1]!.y).toBeLessThan(own[2]!.y);
    }
    expect(checks).toEqual([]);
  });

  it("forwards only slower and longer to a transition", async () => {
    const { record } = await place({
      transitions: [{ ...DIM, wish: "left" }],
      accents: [{ from: "w0", to: "w2", title: false, wish: "slow" }],
    });
    expect(record).toContainEqual(
      expect.objectContaining({ item: "transition-1", action: "wish-not-kept", rule: "wish" }),
    );
    expect(record).toContainEqual(
      expect.objectContaining({ item: "accent-1", action: "wish-not-kept", rule: "wish" }),
    );
  });

  it("is deterministic", async () => {
    const input = {
      transitions: [DIM, { kind: "numbered" as const, from: "w100", to: "w103", key_from: "w102" }],
    };
    const one = await place(input, { headTrack: BIG_FACE });
    const two = await place(input, { headTrack: BIG_FACE });
    expect(two.edit).toEqual(one.edit);
    expect(two.record).toEqual(one.record);
  });
});

describe("making room for a request", () => {
  // The 2026-11-03 answer's items, without its checklist.
  const REQUEST_INPUT: Partial<EngineInput> = {
    photos: REQUEST_ANSWER.photos,
    transitions: REQUEST_ANSWER.transitions,
  };
  const HUGE = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
  const FLOOR = Math.ceil(
    ISSEBYA_PRESET.fonts[ISSEBYA_PRESET.caption.font].size * ISSEBYA_PRESET.layout.minScale,
  );
  const { safe } = ISSEBYA_PRESET;
  const makeRoom = (record: { rule: string; action: string }[]) =>
    record.filter((note) => note.rule === "make-room").map((note) => note.action);

  // Never a caption removed for room: the same captions and words as the
  // plain pass, each placed inside the safe zone, never below the floor.
  async function expectCaptionsKept(
    edit: Edit,
    input: Partial<EngineInput>,
    headTrack: HeadTrack,
  ): Promise<void> {
    const plain = await place(input, { headTrack });
    expect(edit.tracks.captions.map((caption) => [caption.id, caption.words])).toEqual(
      plain.edit.tracks.captions.map((caption) => [caption.id, caption.words]),
    );
    for (const caption of edit.tracks.captions) {
      expect(caption.size!).toBeGreaterThanOrEqual(FLOOR);
      expect(caption.position!.x).toBeGreaterThanOrEqual(safe.left);
      expect(caption.position!.y).toBeGreaterThanOrEqual(safe.top);
    }
  }

  it('places the photo of "add images behind me": the dim Claude added on its own is removed', async () => {
    // The 2026-11-03 case: nothing else shows while a transition runs, so
    // the plain pass drops the photo.
    const input = REQUEST_INPUT;
    const plain = await place(input, { headTrack: LEFT_HEAD });
    expect(plain.edit.tracks.behind).toBeUndefined();
    expect(plain.record).toContainEqual(
      expect.objectContaining({ item: "photo-1", action: "dropped", rule: "one-extra" }),
    );

    const asked = await place(input, { headTrack: LEFT_HEAD, requested: ["photos[0]"] });
    expect(asked.edit.tracks.behind).toEqual([
      expect.objectContaining({
        id: "photo-1",
        kind: "photo",
        photo_id: REQUEST_PHOTO,
      }),
    ]);
    expect(asked.checks).toEqual([]);
    expect(asked.edit.tracks.transitions).toEqual([]);
    expect(asked.record).toContainEqual({
      item: "transition-1",
      action: "removed",
      rule: "make-room",
      reason: "transition 1 (dim) removed: it showed at the same time as photo 1, as asked",
    });
    // Removing it is enough: the captions stay where they were.
    expect(makeRoom(asked.record)).toEqual(["removed"]);
    expect(asked.unplaced).toEqual([]);
    await expectCaptionsKept(asked.edit, input, LEFT_HEAD);
  });

  it("matches the committed request fixture", async () => {
    const fixture = FIXTURES.find((entry) => entry.name === "rethink-work-request")!;
    const made = editFromAnswer(
      hand.edit,
      REQUEST_ANSWER,
      ISSEBYA_PRESET,
      transcript,
      LEFT_HEAD,
      await nodeMeasurer(),
    );
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.edit.tracks).toEqual(fixture.edit.tracks);
    expect(fixture.edit.tracks.behind).toEqual([
      expect.objectContaining({ id: "photo-1", kind: "photo" }),
    ]);
  });

  it("removes Claude's own panel over the photo's sentence: it shows at the same time", async () => {
    const headTrack = steadyHead({ head_top: 300, cx: 250, head_w: 420 });
    const input: Partial<EngineInput> = {
      photos: [{ photo_id: PHOTO, from: "w0", to: "w25" }],
      transitions: [{ kind: "panel", from: "w0", to: "w5", key_from: "w3" }],
    };
    const plain = await place(input, { headTrack });
    expect(plain.edit.tracks.behind).toBeUndefined();
    expect(plain.edit.tracks.transitions).toHaveLength(1);
    const asked = await place(input, { headTrack, requested: ["photos[0]"] });
    expect(asked.edit.tracks.behind).toHaveLength(1);
    expect(makeRoom(asked.record)).toEqual(["removed"]);
    expect(asked.edit.tracks.transitions).toEqual([]);
    expect(asked.checks).toEqual([]);
    await expectCaptionsKept(asked.edit, input, headTrack);
  });

  it("moves the captions before it covers the face, never below the floor", async () => {
    // A wide face over the middle: the captions beside it hold the one spot
    // it leaves, and moving them below the face is not enough on its own.
    const headTrack = steadyHead({ head_top: 250, cx: 540, head_w: 600 });
    const input: Partial<EngineInput> = {
      photos: [{ photo_id: PHOTO, from: "w0", to: "w25" }],
    };
    const plain = await place(input, { headTrack });
    expect(plain.edit.tracks.behind).toBeUndefined();
    expect(plain.record).toContainEqual(
      expect.objectContaining({ item: "photo-1", action: "dropped", rule: "no-room" }),
    );
    const asked = await place(input, { headTrack, requested: ["photos[0]"] });
    expect(asked.edit.tracks.behind).toHaveLength(1);
    expect(makeRoom(asked.record)).toEqual(["moved", "covers-face"]);
    expect(asked.record).toContainEqual({
      item: "cw0",
      action: "moved",
      rule: "make-room",
      reason: expect.stringMatching(
        /move to make room for photo 1: they sit below the face, as asked$/,
      ),
    });
    expect(
      asked.checks.filter((check) => check.rule !== "behind-face" && check.rule !== "face"),
    ).toEqual([]);
    await expectCaptionsKept(asked.edit, input, headTrack);
  });

  it("removes only what stands in the way: Claude's own accent on the same words is kept", async () => {
    // Requested items are placed before Claude's own extras, so the accent
    // never stands in the photo's way by time; the dim does.
    const input: Partial<EngineInput> = {
      ...REQUEST_INPUT,
      accents: [{ from: "w84", to: "w85", title: false }],
    };
    const asked = await place(input, { headTrack: LEFT_HEAD, requested: ["photos[0]"] });
    expect(asked.edit.tracks.behind).toHaveLength(1);
    const removed = asked.record.filter((note) => note.action === "removed");
    expect(removed.map((note) => note.item)).toEqual(["transition-1"]);
    await expectCaptionsKept(asked.edit, input, LEFT_HEAD);
  });

  it("never removes or drops a requested item for another: the later one shifts in its sentence", async () => {
    // A requested accent opens the sentence; the requested photo on the same
    // sentence would show at the same time, so it starts later.
    const input: Partial<EngineInput> = {
      accents: [{ from: "w0", to: "w2", title: false }],
      photos: [{ photo_id: PHOTO, from: "w0", to: "w25" }],
    };
    const plain = await place(input, { headTrack: BIG_FACE });
    expect(plain.record).toContainEqual(
      expect.objectContaining({ item: "photo-1", action: "dropped", rule: "one-extra" }),
    );
    const asked = await place(input, {
      headTrack: BIG_FACE,
      requested: ["accents[0]", "photos[0]"],
    });
    expect(asked.edit.tracks.overlays.map((item) => item.id)).toEqual(["accent-1"]);
    expect(asked.edit.tracks.behind?.map((item) => item.id)).toEqual(["photo-1"]);
    expect(asked.record.filter((note) => note.action === "removed")).toEqual([]);
    const retimed = asked.record.find(
      (note) => note.item === "photo-1" && note.rule === "make-room",
    )!;
    expect(retimed.action).toBe("retimed");
    expect(retimed.reason).toMatch(
      /^photo 1 now shows from \d+\.\d\d s to \d+\.\d\d s, inside its sentence, to find room$/,
    );
    const photo = asked.spans.get("photo-1")!;
    const accent = asked.spans.get("accent-1")!;
    expect(accent.end).toBeLessThanOrEqual(photo.start + 1e-6);
    expect(photo.end).toBeLessThanOrEqual(sentences[0]!.end + 1e-6);
    expect(asked.checks).toEqual([]);
  });

  it("covers the face only as the last step, and records it", async () => {
    // A face over every spot: nothing else can place the photo.
    const input = { photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }] };
    const asked = await place(input, { headTrack: HUGE, requested: ["photos[0]"] });
    expect(asked.edit.tracks.behind).toHaveLength(1);
    expect(asked.record).toContainEqual({
      item: "photo-1",
      action: "covers-face",
      rule: "make-room",
      reason: expect.stringMatching(
        /^photo 1 sits in the (top|left|right) spot over part of the face: nothing else was free, as asked$/,
      ),
    });
    expect(
      asked.checks.filter((check) => check.rule !== "behind-face" && check.rule !== "face"),
    ).toEqual([]);
    await expectCaptionsKept(asked.edit, input, HUGE);
    // A smaller face: removing the dim is enough.
    const request = REQUEST_INPUT;
    const left = await place(request, { headTrack: LEFT_HEAD, requested: ["photos[0]"] });
    expect(left.record.filter((note) => note.action === "covers-face")).toEqual([]);
  });

  it("gives a requested accent its room before the captions", async () => {
    const input = { accents: [{ from: "w84", to: "w86", title: false }] };
    const plain = await place(input, { headTrack: HUGE });
    expect(plain.edit.tracks.overlays).toEqual([]);
    const asked = await place(input, { headTrack: HUGE, requested: ["accents[0]"] });
    expect(asked.edit.tracks.overlays.map((item) => item.id)).toEqual(["accent-1"]);
    // The captions keep clear of it; only the face is covered, as recorded.
    expect(asked.checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
    expect(asked.record).toContainEqual(
      expect.objectContaining({ item: "accent-1", action: "covers-face", rule: "make-room" }),
    );
    await expectCaptionsKept(asked.edit, input, HUGE);
  });

  it("never makes room without a request, and lists what was left out and where it fits", async () => {
    const input: Partial<EngineInput> = {
      accents: [
        { from: "w0", to: "w4", title: true },
        { from: "w2", to: "w3", title: false },
      ],
    };
    const measurer = await nodeMeasurer();
    const placed = placeEdit(
      hand.edit,
      { ...NOTHING, ...input },
      transcript,
      BIG_FACE,
      ISSEBYA_PRESET,
      measurer,
    );
    expect(placed.record.filter((note) => note.rule === "make-room")).toEqual([]);
    expect(placed.unplaced).toEqual([
      {
        ref: "accents[1]",
        id: "accent-1",
        kind: "accent",
        from: "w2",
        to: "w3",
        requested: false,
        why: "busy",
      },
    ]);
    expect(placed.free).toContainEqual({ from: "w26", to: "w62", room_for: ["accent"] });
    expect(placed.free.some((entry) => entry.from === "w0")).toBe(false);
    // The probes commit nothing: the same tracks as without them.
    const again = placeEdit(
      hand.edit,
      { ...NOTHING, ...input },
      transcript,
      BIG_FACE,
      ISSEBYA_PRESET,
      measurer,
    );
    expect(again.tracks).toEqual(placed.tracks);
    expect(again.record).toEqual(placed.record);
  });

  it("is deterministic: the same request gives the same tracks and record", async () => {
    const input = REQUEST_INPUT;
    const one = await place(input, { headTrack: LEFT_HEAD, requested: ["photos[0]"] });
    const two = await place(input, { headTrack: LEFT_HEAD, requested: ["photos[0]"] });
    expect(two.edit).toEqual(one.edit);
    expect(two.record).toEqual(one.record);
  });
});
