import { describe, expect, it } from "vitest";
import { type Backgrounds, backgroundSampler } from "./background.ts";
import { bigWordCoveredShare, maskSpans } from "./behind.ts";
import { baselineEdit } from "./baseline.ts";
import { build } from "./build.ts";
import { editFromAnswer } from "./decide.ts";
import { placeEdit } from "./engine.ts";
import { type EngineInput, choicesOf } from "./engine-input.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import { wordsText } from "./glossary.ts";
import { LAYOUT_PADDING, type Box, type HeadTrack, facesOver } from "./head-track.ts";
import { ISSEBYA_PRESET, PLATFORM_BUTTONS, PLATFORM_SAFE, SHOWN_FLOOR_SECONDS } from "./preset.ts";
import { MIN_TEXT_SIZE, type Edit, parseEdit } from "./schema.ts";
import { backgroundMapOf } from "./test-support/backgrounds.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { baselineInputs } from "./test-support/inputs.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { LEFT_HEAD, REQUEST_ANSWER } from "./test-support/request.ts";
import { resolveTimeline } from "./timeline.ts";
import { type Transcript, sentenceSpans } from "./transcript.ts";
import { levelBoxes } from "./transitions.ts";
import { pickVariants } from "./variant-picker.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
// Rounds a time to the millisecond, as the engine does.
const ms = (t: number) => Math.round(t * 1000) / 1000;
// A LIST's entrance: its layer starts this long before its first word.
const ENTRANCE = ISSEBYA_PRESET.transitions.numbered.seconds;
const { transcript } = hand;
const words = transcript.words;
const byId = new Map(words.map((word) => [word.id, word]));
const sentences = sentenceSpans(transcript);

const NOTHING: EngineInput = {
  accents: [],
  questions: [],
  big_words: [],
  visuals: [],
  lists: [],
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

function withPlaceholderMasks(edit: Edit, spoken: Transcript): Edit {
  const masks = maskSpans(edit, spoken, ISSEBYA_PRESET).map((span, index) => ({
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
    transcript: spoken = transcript,
  }: {
    headTrack?: HeadTrack;
    current?: Edit;
    // Another transcript (the same ids), for a denser opening.
    transcript?: Transcript;
    backgrounds?: Backgrounds;
  } = {},
) {
  const measurer = await nodeMeasurer();
  const made = editFromAnswer(
    current,
    { ...NOTHING, ...input },
    ISSEBYA_PRESET,
    spoken,
    headTrack,
    measurer,
    backgrounds,
  );
  if (!made.ok) throw new Error(made.reasons.join("; "));
  const { checks, html } = build(
    withPlaceholderMasks(made.edit, spoken),
    spoken,
    headTrack,
    ISSEBYA_PRESET,
    measurer,
    { engineRecord: made.record },
  );
  const spans = resolveTimeline(made.edit, spoken);
  return {
    edit: made.edit,
    record: made.record,
    checks,
    html,
    spans,
    levels: levelBoxes(made.edit, spans, byId, ISSEBYA_PRESET, measurer),
  };
}

const extrasOf = (edit: Edit) => [...edit.tracks.overlays, ...(edit.tracks.behind ?? [])];

// Never the same word twice on screen: every caption an accent or a big word
// hides shares a word and some time with it; every caption still shown
// shares no word with an accent or big word shown at the same time.
function expectNoWordTwice(edit: Edit, spans: ReturnType<typeof resolveTimeline>): void {
  const showing = [
    ...edit.tracks.overlays.map((item) => ({ id: item.id, words: item.words ?? [] })),
    ...(edit.tracks.behind ?? []).flatMap((item) =>
      item.kind === "word" ? [{ id: item.id, words: [(item.start as { word: string }).word] }] : [],
    ),
    ...edit.tracks.transitions.map((item) => ({ id: item.id, words: item.words ?? [] })),
  ];
  const meet = (a: string, b: string) => {
    const x = spans.get(a)!;
    const y = spans.get(b)!;
    return x.start < y.end - 1e-6 && y.start < x.end - 1e-6;
  };
  for (const caption of edit.tracks.captions) {
    if (caption.hidden_by) {
      const by = showing.find((extra) => extra.id === caption.hidden_by)!;
      expect(
        caption.words.some((id) => by.words.includes(id)),
        caption.id,
      ).toBe(true);
      expect(meet(caption.id, by.id), caption.id).toBe(true);
      expect(caption.position).toBeUndefined();
      continue;
    }
    if (!caption.position) continue;
    for (const extra of showing) {
      const shared = caption.words.some((id) => extra.words.includes(id));
      expect(shared && meet(caption.id, extra.id), `${caption.id} and ${extra.id}`).toBe(false);
    }
  }
}

// An accent or a big word comes in this long before its first word.
const LEAD = ISSEBYA_PRESET.accent.leadSeconds;
const leadOf = (id: string) => Math.round((byId.get(id)!.start - LEAD) * 1000) / 1000;
// A word's start and end.
const start = (id: string) => byId.get(id)!.start;
const end = (id: string) => byId.get(id)!.end;

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
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "cw94",
        outcome: "retimed",
        rule: "timing",
        reason: 'caption "to" joins the next group, so it shows at least 0.25 s',
      }),
    );
  });

  it("shows an accent exactly while its words are spoken: its first word's start to its last word's end, no minimum", async () => {
    const { spans, edit, record } = await place({
      accents: [
        { from: "w29", to: "w29" },
        { from: "w84", to: "w87" },
      ],
    });
    const one = spans.get("accent-1")!;
    expect([one.start, one.end]).toEqual([start("w29"), end("w29")]);
    expect(edit.tracks.overlays[0]!.start).toEqual({ word: "w29" });
    expect(one.end - one.start).toBeLessThan(1.5);
    const two = spans.get("accent-2")!;
    expect([two.start, two.end]).toEqual([start("w84"), end("w87")]);
    expect(record.filter((note) => note.item === "accent-1" && note.rule === "timing")).toEqual([]);
  });

  it("shows a question as an accent on its words: question-1, the accent's timing and look", async () => {
    const { edit, spans } = await place({ questions: [{ from: "w29", to: "w29" }] });
    expect(edit.tracks.overlays).toEqual([
      expect.objectContaining({
        id: "question-1",
        kind: "accent",
        words: ["w29"],
        start: { word: "w29" },
      }),
    ]);
    const span = spans.get("question-1")!;
    expect([span.start, span.end]).toEqual([start("w29"), end("w29")]);
  });

  it("shows a big word on the accent's timing: the lead before its word to its word's end, at least 1.5 s", async () => {
    const { spans, edit } = await place({ big_words: [{ from: "w76", to: "w76" }] });
    const span = spans.get("big-word-1")!;
    const said = byId.get("w76")!;
    expect(span.start).toBe(leadOf("w76"));
    const sentence = sentences.find((s) => s.from === "w63")!;
    expect(sentence.end).toBeGreaterThan(span.end + 0.5);
    expect(span.end).toBeCloseTo(Math.max(said.end, span.start + 1.5), 3);
    expect(edit.tracks.behind![0]).toMatchObject({
      kind: "word",
      text: "distribution",
      start: { word: "w76", offset: -LEAD },
    });
  });

  it("shows a two-word big word from its first word to its last, both words in it", async () => {
    const { spans, edit, html } = await place({ big_words: [{ from: "w76", to: "w77" }] });
    const span = spans.get("big-word-1")!;
    expect(span.start).toBe(leadOf("w76"));
    expect(span.end).toBeCloseTo(Math.max(byId.get("w77")!.end, span.start + 1.5), 3);
    expect(edit.tracks.behind![0]).toMatchObject({
      kind: "word",
      text: "distribution channel",
      start: { word: "w76", offset: -LEAD },
    });
    expect(html).toContain("distribution channel");
  });

  it("sets a two-word big word on one line in spoken order: one element, first word first", async () => {
    const tr = structuredClone(transcript);
    tr.words.find((w) => w.id === "w76")!.text = "social";
    tr.words.find((w) => w.id === "w77")!.text = "media";
    const { html, edit } = await place(
      { big_words: [{ from: "w76", to: "w77" }] },
      { transcript: tr },
    );
    expect(edit.tracks.behind![0]).toMatchObject({ text: "social media" });
    // One element holding both words in spoken order, on one line (nowrap), so
    // "media" can never stack above "social".
    const elements = html.match(/<div id="big-word-1"[^>]*>[^<]*<\/div>/g) ?? [];
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatch(/>social media<\/div>$/);
    expect(html).toMatch(/\.word \{[^}]*white-space: nowrap;/);
    expect(html).not.toMatch(/big-word-1"[^>]*>social<br/);
  });

  it("shows several big words, the same word again too, each on the accent's timing", async () => {
    // "work" is said at w33 and again at w126.
    const choices = [
      { from: "w33", to: "w33" },
      { from: "w76", to: "w76" },
      { from: "w126", to: "w126" },
    ];
    const { spans, edit, checks } = await place({ big_words: choices });
    const behind = edit.tracks.behind!;
    expect(behind.map((item) => item.id)).toEqual(["big-word-1", "big-word-2", "big-word-3"]);
    expect(behind.map((item) => item.kind === "word" && item.text)).toEqual([
      "work",
      "distribution",
      "work",
    ]);
    behind.forEach((item, index) => {
      const span = spans.get(item.id)!;
      const said = byId.get(choices[index]!.from)!;
      expect(span.start).toBe(leadOf(said.id));
      expect(span.end - span.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
      expect(span.end).toBeLessThanOrEqual(Math.max(said.end + 1, span.start + 1.5) + 1e-6);
    });
    expect(checks).toEqual([]);
  });

  it("shows a visual from its first word, 1 to 2 s, shown even past its short sentence", async () => {
    // "We have it all." and its pauses last 0.9 s: the visual lasts the 1 s
    // minimum all the same (kept, never dropped).
    const short = await place({ visuals: [{ from: "w113", to: "w116" }] });
    expect(short.edit.tracks.behind).toEqual([expect.objectContaining({ id: "visual-1" })]);
    const shortSpan = short.spans.get("visual-1")!;
    expect(shortSpan.end - shortSpan.start).toBeGreaterThanOrEqual(1 - 1e-6);
    // A sentence of 3.2 s: from its start, leaving after 2 s.
    const whole = await place({ visuals: [{ from: "w84", to: "w99" }] });
    const span = whole.spans.get("visual-1")!;
    const sentence = sentences.find((s) => s.from === "w84")!;
    expect(span.start).toBe(sentence.start);
    expect(span.end).toBeCloseTo(sentence.start + 2, 3);
    // A long sentence, visual words late in it: from its first word, 2 s.
    const late = await place({ visuals: [{ from: "w18", to: "w25" }] });
    const lateSpan = late.spans.get("visual-1")!;
    expect(lateSpan.start).toBe(byId.get("w18")!.start);
    expect(lateSpan.end).toBeLessThanOrEqual(sentences[0]!.end + 1e-6);
  });
});

describe("never the same word twice on screen", () => {
  const boxOf = (edit: Edit, ids: readonly string[]) => {
    const placed = edit.tracks.captions.filter((caption) => ids.includes(caption.id));
    return {
      left: Math.min(...placed.map((caption) => caption.position!.x)),
      top: Math.min(...placed.map((caption) => caption.position!.y)),
      bottom: Math.max(...placed.map((caption) => caption.position!.y + caption.size!)),
    };
  };

  it('leaves the accent\'s words out of the caption: "and sense of purpose" reads "and"', async () => {
    const plain = await place({});
    const { edit, spans, checks, html, record } = await place({
      accents: [{ from: "w110", to: "w112" }],
    });
    expect(checks).toEqual([]);
    const caption = (id: string) => edit.tracks.captions.find((item) => item.id === id)!;
    // ("purpose" has no caption of its own in the hand edit.)
    for (const id of ["cw110", "cw111"]) {
      expect(caption(id)).toMatchObject({ hidden_by: "accent-1" });
      expect(caption(id).position).toBeUndefined();
      expect(html).not.toContain(`id="${id}"`);
    }
    expect(caption("cw109").position).toBeDefined();
    expect(html).toContain('id="cw109"');
    // What is left stays inside the group's old box, at its size.
    const was = boxOf(plain.edit, ["cw109", "cw110", "cw111"]);
    const now = caption("cw109");
    expect(now.size).toBe(plain.edit.tracks.captions.find((item) => item.id === "cw109")!.size);
    expect(now.position!.x).toBeGreaterThanOrEqual(was.left);
    expect(now.position!.y).toBeGreaterThanOrEqual(was.top);
    expect(now.position!.y + now.size!).toBeLessThanOrEqual(was.bottom);
    // Nothing noisy in the record: the captions' notes are the plain pass's.
    // The captions' placer notes (`placed` aside, every caption has one).
    const captionNotes = (notes: { item: string; outcome: string }[]) =>
      notes.filter((note) => note.item.startsWith("cw") && note.outcome !== "placed");
    expect(captionNotes(record)).toEqual(captionNotes(plain.record));
    expectNoWordTwice(edit, spans);
  });

  it('leaves the big word out of its caption: "it to the world" reads "it to the"', async () => {
    const { edit, spans, checks } = await place({ big_words: [{ from: "w62", to: "w62" }] });
    expect(checks).toEqual([]);
    const world = edit.tracks.captions.find((item) => item.words.includes("w62"))!;
    expect(world).toMatchObject({ hidden_by: "big-word-1" });
    for (const id of ["w59", "w60", "w61"]) {
      expect(edit.tracks.captions.find((item) => item.words.includes(id))!.position).toBeDefined();
    }
    expectNoWordTwice(edit, spans);
  });

  it("shows no caption while every word of its group is in the accent", async () => {
    const { edit, spans, checks } = await place({
      accents: [{ from: "w117", to: "w122" }],
    });
    expect(checks).toEqual([]);
    const inside = edit.tracks.captions.filter((item) =>
      item.words.every((id) => ["w117", "w118", "w119", "w120", "w121", "w122"].includes(id)),
    );
    expect(inside.length).toBeGreaterThan(0);
    for (const caption of inside) expect(caption.hidden_by).toBe("accent-1");
    expectNoWordTwice(edit, spans);
  });

  it("builds a stored caption without the field as before, and refuses one hidden by nothing", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[3]!.hidden_by = "accent-9";
    const parsed = parseEdit(edit, ISSEBYA_PRESET, transcript);
    expect(!parsed.ok && parsed.reasons.join("\n")).toMatch(
      /caption cw\d+: hidden by accent-9, which is no accent, big word or list/,
    );
  });
});

describe("big words in view", () => {
  const maxCovered = 1 - ISSEBYA_PRESET.behind.word.minVisible;
  const bigWordOf = (edit: Edit, spans: ReturnType<typeof resolveTimeline>) => {
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    if (word.kind !== "word") throw new Error("not a word");
    return { word, span: spans.get(word.id)! };
  };

  it("counts the face only: the body under the face covers nothing, the face covers its share", () => {
    const face: Box = { left: 400, right: 700, top: 300, bottom: 500 };
    // A word wholly under the face's bottom: the body beneath it is not counted.
    const under: Box = { left: 380, right: 720, top: 520, bottom: 720 };
    expect(bigWordCoveredShare(under, [face])).toBe(0);
    // Half of the word's height under the face's bottom edge.
    const half: Box = { left: 380, right: 720, top: 400, bottom: 600 };
    expect(bigWordCoveredShare(half, [face])).toBeCloseTo(0.5, 6);
    // A word beside the face, out of its columns: nothing covered.
    const beside: Box = { left: 0, right: 300, top: 300, bottom: 500 };
    expect(bigWordCoveredShare(beside, [face])).toBe(0);
    expect(bigWordCoveredShare(half, [])).toBe(0);
  });

  it("keeps a short big word at the head's rule place, noted when the head covers more than 30% of it", async () => {
    const measurer = await nodeMeasurer();
    const { edit, spans, checks, record } = await place(
      { big_words: [{ from: "w116", to: "w116" }] },
      { headTrack: BIG_FACE },
    );
    expect(checks).toEqual([]);
    const { word, span } = bigWordOf(edit, spans);
    const width = measurer.width(ISSEBYA_PRESET.behind.word.font, word.size!, word.text);
    const box = {
      left: word.position!.x,
      right: word.position!.x + width,
      top: word.position!.y,
      bottom: word.position!.y + word.size!,
    };
    // The single mode never moves it for the head: the coverage is noted.
    const share = bigWordCoveredShare(box, facesOver(BIG_FACE, span.start, span.end));
    expect(share).toBeGreaterThan(maxCovered);
    expect(box.top).toBeGreaterThanOrEqual(PLATFORM_SAFE.top);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: word.id,
        outcome: "kept-overlapping",
        rule: "text-overlap",
        reason: expect.stringMatching(
          /^the big word ".+" sits with the person covering \d+% of it/,
        ),
      }),
    );
  });
});

describe("the layout engine's placement", () => {
  // Every sentence's first words as an accent, one big word, two visuals and a
  // transition over one reel.
  const DENSE: Partial<EngineInput> = {
    accents: [
      { from: "w0", to: "w4" },
      { from: "w26", to: "w28" },
      { from: "w100", to: "w102" },
      { from: "w117", to: "w120" },
      { from: "w134", to: "w136" },
    ],
    big_words: [{ from: "w76", to: "w76" }],
    visuals: [
      { from: "w84", to: "w99" },
      { from: "w113", to: "w116" },
    ],
    lists: [{ items: [{ from: "w126", to: "w133", key_from: "w128" }] }],
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

  // The face high in the frame: no room above it or in its upper half, so the
  // free part below it is the only place for a front element off the face.
  const FACE_TOP = steadyHead({ head_top: 240, cx: 540, head_w: 500 });

  it("puts an accent on the chest when that is its best spot, below the face", async () => {
    const { edit, spans, record, checks } = await place(
      { accents: [{ from: "w0", to: "w4" }] },
      { headTrack: FACE_TOP },
    );
    const [accent] = edit.tracks.overlays;
    const face = facesOver(FACE_TOP, spans.get(accent!.id)!.start, spans.get(accent!.id)!.end)[0]!;
    expect(accent!.position!.y).toBeGreaterThanOrEqual(face.bottom + gap);
    expect(
      record.filter((note) => note.item === accent!.id && note.outcome === "covers-face"),
    ).toEqual([]);
    expect(checks).toEqual([]);
  });

  // The Intense rhythm: an extra on every sentence (accents, big words and
  // visuals in turn, several of each) and two
  // transitions, far more than fits.
  const RHYTHM: Partial<EngineInput> = { accents: [], questions: [], big_words: [], visuals: [] };
  sentences.forEach((sentence, index) => {
    const from = words.findIndex((word) => word.id === sentence.from);
    const to = words.findIndex((word) => word.id === sentence.to);
    const ids = words.slice(from, to + 1).map((word) => word.id);
    const longest = [...ids].sort(
      (a, b) => byId.get(b)!.text.length - byId.get(a)!.text.length || a.localeCompare(b),
    )[0]!;
    if (index % 3 === 0) {
      RHYTHM.accents!.push({ from: ids[0]!, to: ids[Math.min(2, ids.length - 1)]! });
    } else if (index % 3 === 1) {
      RHYTHM.big_words!.push({ from: longest, to: longest });
    } else {
      RHYTHM.visuals!.push({ from: sentence.from, to: sentence.to });
    }
  });
  RHYTHM.lists = [
    {
      items: [
        { from: "w26", to: "w33", key_from: "w30" },
        { from: "w126", to: "w133", key_from: "w128" },
      ],
    },
  ];

  for (const [name, headTrack] of [
    ["the real head", hand.headTrack],
    ["a large centred face", BIG_FACE],
  ] as const) {
    it(`keeps the lengths and no word twice with an extra on every sentence and ${name}`, async () => {
      const { edit, spans, checks } = await place(RHYTHM, { headTrack });
      expect(checks).toEqual([]);
      const extras = extrasOf(edit).map((item) => spans.get(item.id)!);
      // Visuals last 1 to 2 s; big words the accent's timing, at least
      // 1.5 s and at most a second after their word.
      for (const item of edit.tracks.behind ?? []) {
        const span = spans.get(item.id)!;
        if (item.kind === "visual") {
          expect(span.end - span.start).toBeGreaterThanOrEqual(1 - 1e-6);
          expect(span.end - span.start).toBeLessThanOrEqual(2 + 1e-6);
        } else {
          const said = byId.get((item.start as { word: string }).word)!;
          expect(span.end - span.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
          expect(span.end).toBeLessThanOrEqual(Math.max(said.end + 1, span.start + 1.5) + 1e-6);
        }
      }
      expectNoWordTwice(edit, spans);
      // Many still show: every pick is placed.
      expect(extras.length).toBeGreaterThanOrEqual(6);
    });
  }

  // Every front element (an accent, a question, the hook, a list's level, a
  // visual card) that covers the face at a moment it is shown is noted
  // `covers-face`; a caption fails the face check only as noted. The face is a
  // preference, so the record is the proof that it was the last resort.
  const gap = ISSEBYA_PRESET.layout.gap;
  const overlapsFace = (box: Box, face: Box) =>
    box.left < face.right &&
    face.left < box.right &&
    box.top < face.bottom + gap &&
    face.top - gap < box.bottom;
  const faceDuring = (headTrack: HeadTrack, span: { start: number; end: number }): Box[] =>
    headTrack.flatMap((sample) =>
      sample && sample.t >= span.start && sample.t <= span.end
        ? facesOver(headTrack, sample.t, sample.t, LAYOUT_PADDING)
        : [],
    );
  for (const [name, input] of [
    ["the dense reel", { ...DENSE, hook: { text: "Gen Z won't work like you did" } }],
    ["the rhythm reel", { ...RHYTHM, hook: { text: "Gen Z won't work like you did" } }],
  ] as const) {
    for (const [headName, headTrack] of [
      ["the real head", hand.headTrack],
      ["a large centred face", BIG_FACE],
      ["a face at the top", FACE_TOP],
    ] as const) {
      it(`covers the face only where the record notes it, on ${name} with ${headName}`, async () => {
        const { edit, spans, record, checks, levels } = await place(input, { headTrack });
        const measurer = await nodeMeasurer();
        const noted = new Set(
          record.filter((note) => note.outcome === "covers-face").map((note) => note.item),
        );
        const fronts: { id: string; box: Box; span: { start: number; end: number } }[] = [
          ...edit.tracks.overlays.map((item) => {
            const lines =
              item.kind === "hook"
                ? [item.text!]
                : [wordsText(item.words!, transcript, ISSEBYA_PRESET)];
            const words = lines[0]!.split(" ");
            const broken = item.break_after
              ? [
                  words.slice(0, item.break_after).join(" "),
                  words.slice(item.break_after).join(" "),
                ]
              : lines;
            const width = Math.max(
              ...broken.map((line) => measurer.width(ISSEBYA_PRESET.accent.font, item.size!, line)),
            );
            const { x, y } = item.position!;
            return {
              id: item.id,
              box: { left: x, right: x + width, top: y, bottom: y + broken.length * item.size! },
              span: spans.get(item.id)!,
            };
          }),
          ...(edit.tracks.behind ?? []).flatMap((item) => {
            if (item.kind !== "visual") return [];
            const { x, y, width, height } = item.box!;
            return [
              {
                id: item.id,
                box: { left: x, right: x + width, top: y, bottom: y + height },
                span: spans.get(item.id)!,
              },
            ];
          }),
          ...levels.map((level) => ({
            id: level.transitionId,
            box: {
              left: level.x,
              right: level.x + level.width,
              top: level.y,
              bottom: level.y + level.height,
            },
            span: spans.get(level.transitionId)!,
          })),
        ];
        const uncovered = fronts
          .filter((front) =>
            faceDuring(headTrack, front.span).some((face) => overlapsFace(front.box, face)),
          )
          .filter((front) => !noted.has(front.id))
          .map((front) => front.id);
        expect(uncovered).toEqual([]);
        expect(checks.filter((check) => check.rule === "face" && !noted.has(check.item))).toEqual(
          [],
        );
      });
    }
  }

  // No text starts after its own words, and no two texts share the screen in
  // time, on the dense reels: an earlier text ends where the later one starts.
  // A text the checks need the floor for (a hook, a big word) may overlap the
  // text that cut it; that overlap is noted.
  const WRITTEN = { text: "Gen Z won't work like you did" };
  for (const [name, input] of [
    ["the dense reel", { ...DENSE, hook: WRITTEN }],
    ["the rhythm reel", { ...RHYTHM, hook: WRITTEN }],
  ] as const) {
    for (const [headName, headTrack] of [
      ["the real head", hand.headTrack],
      ["a large centred face", BIG_FACE],
    ] as const) {
      it(`no text lands after its own words, and texts one at a time, on ${name} with ${headName}`, async () => {
        const { edit, spans, record } = await place(input, { headTrack });
        const texts = [
          ...edit.tracks.overlays.map((item) => ({
            id: item.id,
            from: item.start,
            own: item.words?.[0],
          })),
          ...(edit.tracks.behind ?? [])
            .filter((item) => item.kind === "word")
            .map((item) => ({
              id: item.id,
              from: item.start,
              own: (item.start as { word: string }).word,
            })),
          ...edit.tracks.transitions.map((item) => ({
            id: item.id,
            from: item.start,
            own: item.words![0],
          })),
        ];
        for (const text of texts) {
          if (text.id === "hook" || text.own === undefined) continue;
          expect(spans.get(text.id)!.start, text.id).toBeLessThanOrEqual(
            byId.get(text.own)!.start + 1e-6,
          );
        }
        const shown = [...edit.tracks.overlays, ...(edit.tracks.behind ?? [])]
          .filter((item) => item.kind !== "visual")
          .map((item) => ({ id: item.id, ...spans.get(item.id)! }))
          .concat(edit.tracks.transitions.map((item) => ({ id: item.id, ...spans.get(item.id)! })))
          .sort((a, b) => a.start - b.start);
        for (let index = 1; index < shown.length; index += 1) {
          const earlier = shown[index - 1]!;
          const later = shown[index]!;
          if (later.start >= earlier.end - 1e-6) continue;
          // Overlap: only the floor a cut text needs, noted.
          expect(
            record.some(
              (note) =>
                (note.item === earlier.id || note.item === later.id) && note.rule === "timing",
            ),
            `${earlier.id} and ${later.id} overlap`,
          ).toBe(true);
        }
      });
    }
  }

  it("shows an accent said before the hook's start until the hook starts, and keeps the hook's place", async () => {
    const { fromSeconds } = ISSEBYA_PRESET.pace.hook;
    // The same transcript, its first word said before the hook starts.
    const early = {
      ...transcript,
      words: transcript.words.map((word) =>
        word.id === "w0" ? { ...word, start: 0.05, end: 0.3 } : word,
      ),
    };
    const placed = await place(
      { hook: { text: "Gen Z won't work like you did" }, accents: [{ from: "w0", to: "w0" }] },
      { transcript: early },
    );
    const accent = placed.spans.get("accent-1")!;
    expect(accent.start).toBeCloseTo(0.05, 3);
    expect(accent.end).toBeCloseTo(fromSeconds, 3);
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds });
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "accent-1", outcome: "retimed", rule: "timing" }),
    );
    expect(placed.checks).toEqual([]);
  });

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
      { big_words: [{ from: "w76", to: "w76" }] },
      { headTrack: glitch },
    );
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    expect(spans.get(word.id)!.start).toBe(leadOf("w76"));
    if (word.kind !== "word") throw new Error("not a word");
    expect(word.position!.y).toBeGreaterThan(300);
    expect(checks).toEqual([]);
    // The robust face ignores the reading.
    expect(facesOver(glitch, at, at)[0]!.top).toBeGreaterThan(300);
  });

  it("wraps an accent wider than the frame to fit the safe zone", async () => {
    // "social media has given us" is about 1400 px at 110 px, the frame 1080.
    // Two lines at full size fit the safe zone's width, so it keeps 110 px.
    const { edit, record, checks } = await place(
      { accents: [{ from: "w63", to: "w67" }] },
      { headTrack: BIG_FACE },
    );
    const accent = edit.tracks.overlays[0]!;
    expect(accent.id).toBe("accent-1");
    expect(accent.break_after).toBeGreaterThan(0);
    expect(accent.size).toBe(110);
    expect(record.filter((note) => note.item === "accent-1").map((note) => note.outcome)).toEqual([
      "wrapped",
    ]);
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
    expect(record.some((note) => note.outcome === "covers-face")).toBe(true);
  });
});

describe("today's failures, placed by the engine", () => {
  it("keeps a transition's text levels off the face", async () => {
    const { checks, edit, levels } = await place(
      { lists: [{ items: [{ from: "w84", to: "w99", key_from: "w91" }] }] },
      { headTrack: BIG_FACE },
    );
    expect(edit.tracks.transitions).toHaveLength(1);
    // A list of one item has no number: its lead-in and key phrase only.
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

  it("places a visual over its sentence and drops nothing", async () => {
    // The question sentence, on the large face.
    const { edit, checks } = await place(
      { visuals: [{ from: "w84", to: "w99" }] },
      { headTrack: BIG_FACE },
    );
    expect(edit.tracks.behind).toEqual([
      expect.objectContaining({ id: "visual-1", kind: "visual" }),
    ]);
    expect(checks).toEqual([]);
  });
});

describe("visuals: corner cards over the footage", () => {
  const { card } = ISSEBYA_PRESET.behind;
  const gap = ISSEBYA_PRESET.layout.gap;
  // The card at its full size and at the smaller step: a third of the frame's
  // width, 4:5 (360 by 450), and 0.7 of that (252 by 315).
  const FULL = { width: 360, height: 450 };
  const SMALLER = { width: 252, height: 315 };
  // The speech-ten reel's speaker: a head about 336 px wide, its top near
  // y 568 and its centre near x 600 (the median of its head track).
  const SPEECH_TEN = steadyHead({ head_top: 568, cx: 600, head_w: 336 });
  const cardsOf = (edit: Edit) =>
    (edit.tracks.behind ?? []).flatMap((item) => (item.kind === "visual" ? [item] : []));
  const boxOf = (item: { box?: { x: number; y: number; width: number; height: number } }) => ({
    left: item.box!.x,
    right: item.box!.x + item.box!.width,
    top: item.box!.y,
    bottom: item.box!.y + item.box!.height,
  });
  const meets = (a: Box, b: Box) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  it("places a visual as a corner card or beside the face, clear of it, as a white frame", async () => {
    for (const headTrack of [SPEECH_TEN, LEFT_HEAD, BIG_FACE]) {
      const { edit, spans, checks, html } = await place(
        { visuals: [{ from: "w84", to: "w99" }] },
        { headTrack },
      );
      expect(checks).toEqual([]);
      const [visual] = cardsOf(edit);
      expect(visual).toMatchObject({ id: "visual-1", kind: "visual" });
      const box = boxOf(visual!);
      const { width, height } = visual!.box!;
      expect([FULL, SMALLER]).toContainEqual(expect.objectContaining({ width, height }));
      expect(width / height).toBeCloseTo(card.aspect, 2);
      // Inside the platform safe zone, and off the face (each of these heads
      // leaves a corner or side free; see the cover test below).
      expect(box.left).toBeGreaterThanOrEqual(PLATFORM_SAFE.left);
      expect(box.right).toBeLessThanOrEqual(PLATFORM_SAFE.right);
      expect(box.top).toBeGreaterThanOrEqual(PLATFORM_SAFE.top);
      expect(box.bottom).toBeLessThanOrEqual(PLATFORM_SAFE.bottom);
      const span = spans.get("visual-1")!;
      const faces = facesOver(headTrack, span.start, span.end);
      for (const face of faces) expect(meets(box, face)).toBe(false);
      // At a corner of the safe zone, or beside the face.
      const atCorner =
        (box.left === PLATFORM_SAFE.left + card.inset ||
          box.right === PLATFORM_SAFE.right - card.inset) &&
        (box.top === PLATFORM_SAFE.top + card.inset ||
          box.bottom === PLATFORM_SAFE.bottom - card.inset);
      const beside = faces.some(
        (face) => box.right === face.left - gap || box.left === face.right + gap,
      );
      expect(atCorner || beside).toBe(true);
      // The frame: a white stroke at the preset's width, no picture, no words,
      // no cut-out, drawn at the card's size.
      expect(maskSpans(edit, transcript, ISSEBYA_PRESET)).toEqual([]);
      expect(html).toMatch(/<div id="visual-1" class="clip visual"[^>]*data-track-index="30"/);
      expect(html).toContain(
        `.visual { position: absolute; box-sizing: border-box; border: ${card.stroke}px solid #ffffff; background: transparent; }`,
      );
      expect(html).not.toMatch(/<img id="visual-1"/);
    }
  });

  it("takes the full card size where a corner or side is free, and the smaller step before the corner overlap", async () => {
    const roomy = await place({ visuals: [{ from: "w84", to: "w99" }] }, { headTrack: BIG_FACE });
    const [full] = cardsOf(roomy.edit);
    expect({ width: full!.box!.width, height: full!.box!.height }).toEqual(FULL);
    expect(roomy.record.filter((note) => note.rule === "size")).toEqual([]);
    // The speech-ten head: no corner or side takes the full card, the 0.7 step does.
    const tight = await place({ visuals: [{ from: "w84", to: "w99" }] }, { headTrack: SPEECH_TEN });
    const [smaller] = cardsOf(tight.edit);
    expect({ width: smaller!.box!.width, height: smaller!.box!.height }).toEqual(SMALLER);
    expect(tight.record).toContainEqual(
      expect.objectContaining({
        item: "visual-1",
        outcome: "shrunk",
        rule: "size",
        reason: expect.stringMatching(
          /^visual 1 set at 252 by 315 px instead of 360 by 450: no corner or side is free at full size from .+ to .+$/,
        ),
      }),
    );
    expect(tight.checks).toEqual([]);
  });

  it("covers the face with a card only when every corner and side is taken, noted covers-face", async () => {
    const covers = (record: { outcome: string }[]) =>
      record.filter((note) => note.outcome === "covers-face");
    // A corner or side is free at the full size: no cover, no note.
    const roomy = await place({ visuals: [{ from: "w84", to: "w99" }] }, { headTrack: BIG_FACE });
    expect(covers(roomy.record)).toEqual([]);
    // Only the smaller step fits off the face: still not over it.
    const tight = await place({ visuals: [{ from: "w84", to: "w99" }] }, { headTrack: SPEECH_TEN });
    expect(covers(tight.record)).toEqual([]);
    // A face filling the safe zone takes every corner and side at both sizes.
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const covered = await place({ visuals: [{ from: "w84", to: "w99" }] }, { headTrack: huge });
    const card = covered.record.filter((note) => note.item === "visual-1");
    expect(card).toEqual([expect.objectContaining({ outcome: "covers-face", rule: "face" })]);
  });

  it("keeps the card's size and ratio across the reel", async () => {
    const { edit, checks } = await place(
      {
        visuals: [
          { from: sentences[0]!.from, to: sentences[0]!.to },
          { from: sentences[1]!.from, to: sentences[1]!.to },
          { from: sentences[2]!.from, to: sentences[2]!.to },
        ],
      },
      { headTrack: LEFT_HEAD },
    );
    expect(checks).toEqual([]);
    const placed = cardsOf(edit);
    expect(placed.length).toBeGreaterThanOrEqual(2);
    for (const visual of placed) {
      const { width, height } = visual.box!;
      expect([FULL, SMALLER]).toContainEqual(expect.objectContaining({ width, height }));
      expect(width / height).toBeCloseTo(card.aspect, 2);
    }
  });

  it("moves a visual whose white edge blends with the footage, else keeps it plain and records it", async () => {
    const FRAME = ISSEBYA_PRESET.frame;
    const input = { visuals: [{ from: "w84", to: "w99" }] };
    const plain = await place(input);
    const first = boxOf(cardsOf(plain.edit)[0]!);
    // A light area just around where it would sit, dark everywhere else.
    const wall = backgroundSampler(
      backgroundMapOf(FRAME, hand.edit.duration, (x, y) =>
        x >= first.left - 200 &&
        x < first.right + 200 &&
        y >= first.top - 200 &&
        y < first.bottom + 200
          ? "#E8E8E8"
          : "#202020",
      ),
      FRAME,
    );
    // Its white edge is measured against the light area around it: a note
    // says whether it moved to a place that stands out or stays.
    const measured = await place(input, { backgrounds: wall });
    expect(measured.checks).toEqual([]);
    expect(
      measured.record.filter((note) => note.item === "visual-1" && note.rule === "contrast"),
    ).toHaveLength(1);
    // Light everywhere: it stays, a plain frame with no shadow or colour change.
    const allLight = backgroundSampler(
      backgroundMapOf(FRAME, hand.edit.duration, () => "#E8E8E8"),
      FRAME,
    );
    const kept = await place(input, { backgrounds: allLight });
    expect(boxOf(cardsOf(kept.edit)[0]!)).toEqual(first);
    expect(kept.record).toContainEqual(
      expect.objectContaining({
        item: "visual-1",
        outcome: "placed",
        rule: "contrast",
        reason: expect.stringMatching(
          /^visual 1 stays in place: contrast 1\.\d:1 against the footage around it from .+, no free place nearby reaches 1\.5:1; a visual never gets a shadow or a colour change$/,
        ),
      }),
    );
    expect(kept.html).not.toMatch(/<div id="visual-1"[^>]*(shadow|filter)/);
    // Without a background map nothing is measured.
    const unknown = await place(input);
    expect(
      unknown.record.filter((note) => note.item === "visual-1" && note.rule === "contrast"),
    ).toEqual([]);
  });
});

describe("clicks on visuals and big words", () => {
  it("clicks as each placed visual and big word comes in, and nothing else", async () => {
    const { edit, spans, checks, html } = await place(
      {
        accents: [{ from: "w26", to: "w28" }],
        big_words: [{ from: "w116", to: "w116" }],
        visuals: [{ from: "w84", to: "w99" }],
        lists: [{ items: [{ from: "w126", to: "w133", key_from: "w128" }] }],
      },
      { headTrack: LEFT_HEAD },
    );
    expect(checks).toEqual([]);
    const behind = edit.tracks.behind ?? [];
    expect(behind.map((item) => item.id).sort()).toEqual(["big-word-1", "visual-1"]);
    // The hand edit's own click is not kept: the sounds are the engine's.
    expect(edit.tracks.sounds.map((sound) => sound.id)).toEqual([
      "click-visual-1",
      "click-big-word-1",
    ]);
    for (const sound of edit.tracks.sounds) {
      const item = behind.find((entry) => `click-${entry.id}` === sound.id)!;
      expect(sound.start).toEqual(item.start);
      expect(spans.get(sound.id)!.start).toBeCloseTo(spans.get(item.id)!.start, 6);
    }
    // The big word's click on its lead, 0.2 s before its word.
    expect(spans.get("click-big-word-1")!.start).toBeCloseTo(byId.get("w116")!.start - 0.2, 3);
    expect(html).toMatch(/<audio id="click-visual-1" class="clip" [^>]*data-volume="0\.5012">/);
  });

  it("clicks a visual the face leaves no corner for, and has no click without visuals or big words", async () => {
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const shown = await place({ visuals: [{ from: "w84", to: "w99" }] }, { headTrack: huge });
    expect(shown.edit.tracks.behind).toEqual([expect.objectContaining({ id: "visual-1" })]);
    expect(shown.edit.tracks.sounds).toHaveLength(1);
    const none = await place({ accents: [{ from: "w26", to: "w28" }] });
    expect(none.edit.tracks.sounds).toEqual([]);
  });

  it("leaves a stored version's sounds as they are", () => {
    // The hand edit is never placed again: its one click builds as stored.
    expect(hand.edit.tracks.sounds.map((sound) => sound.id)).toEqual(["s-fund-life"]);
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
  const ACCENT: Partial<EngineInput> = { accents: [{ from: "w84", to: "w87" }] };

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
    expect(moved.color).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({ item: first.id, outcome: "moved", rule: "contrast" }),
    );
    const note = record.find((entry) => entry.rule === "contrast" && entry.outcome === "moved")!;
    expect(note.reason).toMatch(
      /^captions ".+" moves \d+ px to a free place it reads on: contrast 1\.\d:1 from \d+\.\d\d s to \d+\.\d\d s, under 4\.5:1, now \d+\.\d:1$/,
    );
    expect(
      record.filter((entry) => entry.rule === "contrast" && entry.outcome === "placed"),
    ).toEqual([]);
    expect(checks).toEqual([]);
  });

  it("keeps the place, plain, when no free place nearby reads: only a note", async () => {
    const before = await place({});
    for (const color of [BEIGE, "#8A8A8A"]) {
      const { edit, record, checks } = await place({}, { backgrounds: mapOf(() => color) });
      expect(edit.tracks.captions.map((caption) => caption.position)).toEqual(
        before.edit.tracks.captions.map((caption) => caption.position),
      );
      for (const caption of edit.tracks.captions) {
        expect(caption.color).toBeUndefined();
      }
      const notes = record.filter((entry) => entry.rule === "contrast");
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0]!.outcome).toBe("placed");
      expect(notes[0]!.reason).toMatch(
        /^captions ".+" stay in place: contrast \d\.\d:1 from .* no free place nearby reaches 4\.5:1$/,
      );
      expect(
        record.filter((entry) => entry.rule === "contrast" && entry.outcome === "moved"),
      ).toEqual([]);
      // Low contrast is recorded only: no check fails on it.
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
    expect(moved.color).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({ item: "accent-1", outcome: "moved", rule: "contrast" }),
    );
    expect(checks).toEqual([]);
  });

  it("keeps the accent in place, plain, when beige is all around: never a colour", async () => {
    const before = await place(ACCENT);
    const { edit, record } = await place(ACCENT, { backgrounds: mapOf(() => BEIGE) });
    const accent = edit.tracks.overlays[0]!;
    expect(accent.position).toEqual(before.edit.tracks.overlays[0]!.position);
    expect(accent.color).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "accent-1",
        outcome: "placed",
        rule: "contrast",
        reason: expect.stringMatching(
          /^accent ".+" stays in place: contrast 1\.\d:1 from \d+\.\d\d s to \d+\.\d\d s, no free place nearby reaches 3:1$/,
        ),
      }),
    );
  });

  it("leaves the big word in place, plain, on a light background and never moves it", async () => {
    const input = { big_words: [{ from: "w76", to: "w76" }] };
    const before = await place(input);
    const { edit, record } = await place(input, { backgrounds: mapOf(() => BEIGE) });
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    const was = before.edit.tracks.behind!.find((item) => item.kind === "word")!;
    if (word.kind !== "word" || was.kind !== "word") throw new Error("not a word");
    expect(word.position).toEqual(was.position);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "big-word-1",
        outcome: "placed",
        rule: "contrast",
        reason: expect.stringMatching(
          /^the big word ".+" stays in place: .*the big word is never moved$/,
        ),
      }),
    );
    expect(
      record.filter(
        (entry) =>
          entry.item === "big-word-1" && entry.rule === "contrast" && entry.outcome === "moved",
      ),
    ).toEqual([]);
  });

  it("changes nothing on a dark background: the same edit and record as with no map", async () => {
    const input = { ...ACCENT, big_words: [{ from: "w76", to: "w76" }] };
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
      lists: [{ items: [{ from: "w126", to: "w133", key_from: "w128" }] }],
    };
    const { edit, record } = await place(input, { backgrounds: mapOf(() => "#FFFFFF") });
    const [transition] = edit.tracks.transitions;
    expect(transition!.levels).toBeDefined();
    // Its phrase's captions show only as its levels: no place, no note.
    const phrase = new Set(transition!.words);
    const inside = edit.tracks.captions.filter((caption) => phrase.has(caption.words[0]!));
    expect(inside.length).toBeGreaterThan(0);
    for (const caption of inside) {
      expect(caption.position).toBeUndefined();
    }
    expect(
      record.filter(
        (note) =>
          note.rule === "contrast" &&
          note.outcome === "placed" &&
          inside.some((caption) => caption.id === note.item),
      ),
    ).toEqual([]);
    expect(
      record.filter((note) => note.item === "transition-1" && note.rule === "contrast"),
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
  const LIST = { from: "w26", to: "w33", key_from: "w30" };

  it("comes in as its entrance ends on w26's start (0.3 s before), gone at w33's end", async () => {
    const { spans, levels, edit, html, checks } = await place({ lists: [{ items: [LIST] }] });
    const span = spans.get("transition-1")!;
    expect(span.start).toBe(ms(start("w26") - ENTRANCE));
    expect(span.end).toBe(end("w33"));
    expect(edit.tracks.transitions[0]).toMatchObject({
      end: { word: "w33", edge: "end" },
    });
    expect(edit.tracks.transitions[0]).toMatchObject({
      type: "numbered",
      words: ["w26", "w27", "w28", "w29", "w30", "w31", "w32", "w33"],
      key: "w30",
    });
    // Each level appears whole on its first word and stays until it leaves.
    const lead = levels.find((level) => level.role === "lead")!;
    const key = levels.find((level) => level.role === "key")!;
    expect(lead.start).toBe(start("w26"));
    expect(key.start).toBe(start("w30"));
    expect([lead.end, key.end]).toEqual([span.end, span.end]);
    // The layer's fade ends as w26 starts.
    expect(span.start + ENTRANCE).toBeCloseTo(start("w26"), 3);
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

  it("does not hold after its phrase: it leaves at the last word's end, before a long pause", async () => {
    const paused = withPause("w33", 3);
    const made = editFromAnswer(
      paused.edit,
      { ...NOTHING, lists: [{ items: [LIST] }] },
      ISSEBYA_PRESET,
      paused.transcript,
      hand.headTrack,
      await nodeMeasurer(),
    );
    if (!made.ok) throw new Error(made.reasons.join("; "));
    const span = resolveTimeline(made.edit, paused.transcript).get("transition-1")!;
    expect(span.end).toBe(ms(end("w33")));
    expect(T).not.toHaveProperty("holdSeconds");
  });

  it("has no minimum: a short phrase shows its words, from the entrance before them, not lengthened", async () => {
    const { spans, checks, record } = await place({
      lists: [{ items: [{ from: "w26", to: "w27", key_from: "w26" }] }],
    });
    const span = spans.get("transition-1")!;
    expect([span.start, span.end]).toEqual([ms(start("w26") - ENTRANCE), end("w27")]);
    expect(
      record.filter((note) => note.item === "transition-1" && note.outcome === "retimed"),
    ).toEqual([]);
    expect(checks).toEqual([]);
  });

  it("sets the lead-in in caption text and the key phrase in accent text, inside the safe zone", async () => {
    const { levels, checks } = await place({ lists: [{ items: [LIST] }] }, { headTrack: BIG_FACE });
    const { box: safe } = SAFE_ZONE;
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
      expect(level.x).toBeGreaterThanOrEqual(safe.left - 1e-6);
      expect(level.x + level.width).toBeLessThanOrEqual(safe.right + 1e-6);
      expect(level.y).toBeGreaterThanOrEqual(safe.top - 1e-6);
      expect(level.y + level.height).toBeLessThanOrEqual(safe.bottom + 1e-6);
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
  });

  it("covers the face only when the face fills its area, and records it", async () => {
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const { record, edit } = await place({ lists: [{ items: [LIST] }] }, { headTrack: huge });
    expect(edit.tracks.transitions).toHaveLength(1);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "transition-1",
        outcome: "covers-face",
        rule: "face",
      }),
    );
  });

  it("numbers list items 1, 2, 3 in reel order, the number above the lead-in and the key phrase", async () => {
    const { edit, levels, checks } = await place({
      lists: [
        {
          items: [
            { from: "w106", to: "w108", key_from: "w107" },
            { from: "w100", to: "w103", key_from: "w102" },
            { from: "w117", to: "w119", key_from: "w118" },
          ],
        },
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

  it("numbers each list from 1: two lists in one reel count 1, 2, then 1, 2, 3", async () => {
    const { edit, checks } = await place({
      lists: [
        {
          items: [
            { from: "w100", to: "w103", key_from: "w102" },
            { from: "w106", to: "w108", key_from: "w107" },
          ],
        },
        {
          items: [
            { from: "w117", to: "w119", key_from: "w118" },
            { from: "w126", to: "w133", key_from: "w128" },
            { from: "w140", to: "w142", key_from: "w141" },
          ],
        },
      ],
    });
    expect(edit.tracks.transitions.map((item) => [item.id, item.list, item.number])).toEqual([
      ["transition-1", 1, 1],
      ["transition-2", 1, 2],
      ["transition-3", 2, 1],
      ["transition-4", 2, 2],
      ["transition-5", 2, 3],
    ]);
    expect(checks).toEqual([]);
  });

  it("gives a list of one item no number: its text is its levels without one", async () => {
    const { edit, levels, checks } = await place({
      lists: [
        { items: [{ from: "w126", to: "w133", key_from: "w128" }] },
        {
          items: [
            { from: "w100", to: "w103", key_from: "w102" },
            { from: "w106", to: "w108", key_from: "w107" },
          ],
        },
      ],
    });
    expect(edit.tracks.transitions.map((item) => [item.id, item.list, item.number])).toEqual([
      ["transition-1", 1, undefined],
      ["transition-2", 2, 1],
      ["transition-3", 2, 2],
    ]);
    expect(edit.tracks.transitions[0]!.levels!.number).toBeUndefined();
    expect(
      levels.some((level) => level.transitionId === "transition-1" && level.role === "number"),
    ).toBe(false);
    expect(checks).toEqual([]);
  });

  it("reads two placed lists back as the same lists, and places them again the same", async () => {
    const input = {
      lists: [
        {
          items: [
            { from: "w100", to: "w103", key_from: "w102" },
            { from: "w106", to: "w108", key_from: "w107" },
          ],
        },
        { items: [{ from: "w126", to: "w133", key_from: "w128" }] },
      ],
    };
    const { edit } = await place(input);
    const read = choicesOf(edit, transcript, ISSEBYA_PRESET);
    expect(read.lists).toEqual(input.lists);
    const again = await place(read, { current: edit });
    expect(again.edit.tracks).toEqual(edit.tracks);
  });

  it("is deterministic", async () => {
    const input = {
      lists: [{ items: [LIST, { from: "w100", to: "w103", key_from: "w102" }] }],
    };
    const one = await place(input, { headTrack: BIG_FACE });
    const two = await place(input, { headTrack: BIG_FACE });
    expect(two.edit).toEqual(one.edit);
    expect(two.record).toEqual(one.record);
  });
});

describe("a request's visual", () => {
  // The 2026-11-03 answer's items, without its checklist.
  const REQUEST_INPUT: Partial<EngineInput> = {
    visuals: REQUEST_ANSWER.visuals,
    lists: REQUEST_ANSWER.lists,
  };
  const FLOOR = Math.ceil(
    ISSEBYA_PRESET.fonts[ISSEBYA_PRESET.caption.font].size * ISSEBYA_PRESET.layout.minScale,
  );
  const { box: safe } = SAFE_ZONE;

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
      // A caption whose words an accent shows is left out while it shows.
      if (caption.hidden_by) {
        const by = edit.tracks.overlays.find((item) => item.id === caption.hidden_by)!;
        expect(by.words).toEqual(expect.arrayContaining(caption.words));
        continue;
      }
      expect(caption.size!).toBeGreaterThanOrEqual(FLOOR);
      expect(caption.position!.x).toBeGreaterThanOrEqual(safe.left);
      expect(caption.position!.y).toBeGreaterThanOrEqual(safe.top);
    }
  }

  it('places the visual of "add images behind me" over its sentence, the captions kept', async () => {
    // The 2026-11-03 case: the visual over the question sentence, the captions
    // moved (never removed) to make room for it.
    const input = REQUEST_INPUT;
    const asked = await place(input, { headTrack: LEFT_HEAD });
    expect(asked.edit.tracks.behind).toEqual([
      expect.objectContaining({ id: "visual-1", kind: "visual" }),
    ]);
    expect(asked.checks).toEqual([]);
    expect(asked.edit.tracks.transitions).toEqual([]);
    await expectCaptionsKept(asked.edit, input, LEFT_HEAD);
  });

  it("places the visual with its description kept", async () => {
    const asked = await place(REQUEST_INPUT, { headTrack: LEFT_HEAD });
    expect(asked.edit.tracks.behind).toEqual([
      expect.objectContaining({
        id: "visual-1",
        kind: "visual",
        description: REQUEST_ANSWER.visuals![0]!.description,
      }),
    ]);
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
      expect.objectContaining({ id: "visual-1", kind: "visual" }),
    ]);
  });

  it("is deterministic: the same request gives the same tracks and record", async () => {
    const input = REQUEST_INPUT;
    const one = await place(input, { headTrack: LEFT_HEAD });
    const two = await place(input, { headTrack: LEFT_HEAD });
    expect(two.edit).toEqual(one.edit);
    expect(two.record).toEqual(one.record);
  });
});

describe("the written hook", () => {
  const HOOK = { text: "Gen Z won't work like you did" };
  const { box: safe } = SAFE_ZONE;
  const { fromSeconds, untilSeconds } = ISSEBYA_PRESET.pace.hook;
  const hookOf = (edit: Edit) => edit.tracks.overlays.find((item) => item.kind === "hook");
  // A face at the top, narrow enough that the hook fits beside it only when
  // set below the smallest size.
  const NARROW_HEAD = steadyHead({ head_top: 100, cx: 540, head_w: 300 });
  const preset110 = ISSEBYA_PRESET.fonts[ISSEBYA_PRESET.accent.font].size;

  it("shows from 0.2 s to 3 s in the upper part of the frame, off the face, inside the safe zone", async () => {
    const placed = await place({ hook: HOOK });
    const item = hookOf(placed.edit)!;
    expect(item).toMatchObject({ id: "hook", kind: "hook", text: HOOK.text });
    expect(item.words).toBeUndefined();
    expect(item.color).toBeUndefined();
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds, end: untilSeconds });
    // Wrapped or shrunk to fit, recorded; always above the middle of the safe zone.
    expect(item.position!.y).toBeGreaterThanOrEqual(safe.top);
    expect(item.position!.y).toBeLessThan((safe.top + safe.bottom) / 2);
    expect(
      placed.record.filter((note) => note.item === "hook").map((note) => note.outcome),
    ).toEqual(expect.arrayContaining(["wrapped"]));
    // Its own class, the accents' entrance.
    expect(placed.html).toContain('class="text hook f-primary"');
    expect(placed.html).toContain(".hook { text-align: center; }");
    expect(placed.checks).toEqual([]);
    // Nobody says it: no caption is left out for it.
    expect(placed.edit.tracks.captions.some((caption) => caption.hidden_by === "hook")).toBe(false);
    expectNoWordTwice(placed.edit, placed.spans);
  });

  it("cuts the hook where an accent said after its floor starts, noted: the accent shows at its own words", async () => {
    const placed = await place({
      hook: HOOK,
      accents: [
        { from: "w9", to: "w9" },
        { from: "w12", to: "w12" },
      ],
    });
    expect(placed.edit.tracks.overlays.map((item) => item.id)).toEqual([
      "hook",
      "accent-1",
      "accent-2",
    ]);
    // The hook keeps its start and place; the accent's own word ends it.
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds, end: start("w9") });
    expect(placed.spans.get("accent-1")).toMatchObject({ start: start("w9"), end: end("w9") });
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "hook",
        outcome: "retimed",
        rule: "timing",
        reason: expect.stringMatching(
          /^the hook "Gen Z won't work like you did" shows from \d+\.\d\d s to \d+\.\d\d s, not to 3\.00 s: accent "[^"]+" starts at \d+\.\d\d s, and text picks show one at a time; the words it no longer shows show as captions$/,
        ),
      }),
    );
    // The accent said after the hook is not moved.
    expect(placed.spans.get("accent-2")!.start).toBe(start("w12"));
    expect(placed.checks).toEqual([]);
  });

  it("gives the hook its shown floor when an accent starts inside it, the floor over it, noted", async () => {
    const placed = await place({ hook: HOOK, accents: [{ from: "w2", to: "w3" }] });
    expect(placed.spans.get("hook")).toMatchObject({
      start: fromSeconds,
      end: ms(fromSeconds + SHOWN_FLOOR_SECONDS),
    });
    expect(placed.spans.get("accent-1")).toMatchObject({ start: start("w2"), end: end("w3") });
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "hook", outcome: "retimed", rule: "timing" }),
    );
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "accent-1",
        outcome: "kept-overlapping",
        rule: "text-overlap",
      }),
    );
    expect(placed.checks).toEqual([]);
  });

  it("the accent said in the hook's window keeps its own words, whatever the hook shows", async () => {
    const placed = await place({ hook: HOOK, accents: [{ from: "w9", to: "w9" }] });
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds, end: start("w9") });
    expect(placed.edit.tracks.overlays.map((item) => item.id)).toEqual(["hook", "accent-1"]);
    expect(placed.spans.get("accent-1")).toMatchObject({ start: start("w9"), end: end("w9") });
    expect(placed.checks).toEqual([]);
  });

  it("keeps the hook's place and size when an accent and a visual are asked for in its window; the visual is not cut", async () => {
    const hookOnly = await place({ hook: HOOK });
    const crowded = await place({
      hook: HOOK,
      accents: [{ from: "w9", to: "w9" }],
      visuals: [{ from: "w2", to: "w5" }],
    });
    // The hook is the same item in place and size; only its end is cut.
    const placeOf = (edit: Edit) => ({ ...hookOf(edit)!, start: null, end: null });
    expect(placeOf(crowded.edit)).toEqual(placeOf(hookOnly.edit));
    expect(crowded.spans.get("hook")).toMatchObject({ start: fromSeconds, end: start("w9") });
    // What is asked for in its window is shown, noted: the accent comes in at its
    // own words (text picks one at a time), the visual is not text and is not cut.
    expect(crowded.edit.tracks.overlays.map((item) => item.id)).toEqual(["hook", "accent-1"]);
    expect(crowded.edit.tracks.behind?.map((item) => item.id)).toEqual(["visual-1"]);
    const visualOnly = await place({ visuals: [{ from: "w2", to: "w5" }] });
    expect(crowded.spans.get("visual-1")).toEqual(visualOnly.spans.get("visual-1"));
    expect(crowded.record).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: "hook",
          outcome: "retimed",
          rule: "timing",
        }),
        expect.objectContaining({
          item: "visual-1",
          outcome: "kept-overlapping",
          rule: "text-overlap",
        }),
      ]),
    );
    expect(crowded.checks).toEqual([]);
  });

  it("reads back as its text and places the same again; a version without one reads null", async () => {
    const measurer = await nodeMeasurer();
    const placed = await place({ hook: HOOK, accents: [{ from: "w12", to: "w14" }] });
    const choices = choicesOf(placed.edit, transcript, ISSEBYA_PRESET);
    expect(choices.hook).toEqual(HOOK);
    expect(choicesOf(hand.edit, transcript, ISSEBYA_PRESET).hook).toBeNull();
    const again = placeEdit(
      { ...hand.edit, tracks: { ...hand.edit.tracks, ...placed.edit.tracks } },
      choices,
      pickVariants(choices),
      transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      measurer,
    );
    expect(again.tracks.overlays).toEqual(placed.edit.tracks.overlays);
  });

  it("keeps its slot in a caption-heavy opening: the captions in its window keep clear of it", async () => {
    // Sixty words in the first 3 s, a sentence every two words: a caption
    // on every word, so the opening is all captions.
    const dense = words.slice(0, 60).map((word, index) => ({
      id: word.id,
      text: (index + 1) % 2 === 0 ? `${word.text}.` : word.text,
      start: 0.2 + index * 0.05,
      end: 0.2 + index * 0.05 + 0.045,
    }));
    const spoken = {
      words: [
        ...dense,
        ...words.slice(60).map((word) => ({ ...word, start: word.start + 3, end: word.end + 3 })),
      ],
    };
    const current = {
      ...hand.edit,
      tracks: {
        ...hand.edit.tracks,
        captions: dense.map((word, index) => ({
          id: `cw${index}`,
          start: { word: word.id },
          end: { word: word.id, edge: "end" as const },
          words: [word.id],
          size: 50,
          position: { x: 100, y: 300, align: "left" as const },
        })),
        overlays: [],
        lists: [],
        behind: [],
        sounds: [],
      },
    };
    const placed = await place(
      { hook: { text: "Nobody tells you how work feels now" } },
      { current, transcript: spoken },
    );
    // The hook shows its whole window, in the upper part.
    expect(hookOf(placed.edit)).toBeDefined();
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds, end: untilSeconds });
    // The captions in its window are placed too (around it where they fit).
    const inWindow = placed.edit.tracks.captions.filter((caption) => {
      const span = placed.spans.get(caption.id);
      return span && span.start < untilSeconds && span.end > fromSeconds && caption.position;
    });
    expect(inWindow.length).toBeGreaterThan(0);
    // So many captions leave no free place beside the face: they go over it,
    // by the caption fallback, recorded; every other check passes.
    expect(placed.record).toContainEqual(
      expect.objectContaining({ outcome: "covers-face", rule: "face" }),
    );
    expect(placed.checks.filter((check) => check.rule !== "face")).toEqual([]);
    expectNoWordTwice(placed.edit, placed.spans);
  });

  it("is never dropped for its size: wide words shrink it until two lines fit the frame", async () => {
    // Seven words of wide letters, the longest the schema allows: no size
    // at the floor fits them in two lines, so it shrinks below the floor.
    const WIDE = { text: "WWWWWW WWWWWW WWWWWW WWWWWW WWWWWW WWWWWW WWW" };
    const placed = await place({ hook: WIDE });
    const item = hookOf(placed.edit)!;
    expect(item.size).toBeLessThan(preset110);
    expect(
      placed.record.filter((note) => note.item === "hook").map((note) => note.outcome),
    ).toEqual(expect.arrayContaining(["shrunk"]));
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds, end: untilSeconds });
    expect(placed.checks).toEqual([]);
  });

  it("never sets the hook below the schema minimum size, even for a very long word or sentence", async () => {
    const texts = [
      "Pneumonoultramicroscopicsilicovolcanoconiosisxxxxxxxxxxxxxxxxxxxxxxx",
      "Nobody tells you that the way work feels now is shaped by the screens we carry and the feeds we scroll",
    ];
    for (const text of texts) {
      const placed = await place({ hook: { text } }, { headTrack: NARROW_HEAD });
      const item = hookOf(placed.edit)!;
      expect(item.size).toBeGreaterThanOrEqual(MIN_TEXT_SIZE);
      expect(parseEdit(placed.edit, ISSEBYA_PRESET, transcript).ok).toBe(true);
    }
  });

  it("shows on a reel too short for its window from earlier, to the reel's end, and records it", async () => {
    const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;
    const measurer = await nodeMeasurer();
    const tiny = { ...short.edit, duration: 0.6 };
    const choices = { ...NOTHING, hook: HOOK };
    const placed = placeEdit(
      tiny,
      choices,
      pickVariants(choices),
      short.transcript,
      short.headTrack,
      ISSEBYA_PRESET,
      measurer,
    );
    expect(placed.tracks.overlays.map((item) => item.id)).toEqual(["hook"]);
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "hook", outcome: "retimed", rule: "timing" }),
    );
  });
});

describe("text picks one at a time", () => {
  const LIST_AT_W26 = { from: "w26", to: "w33", key_from: "w30" };

  it("keeps a word an accent shows just before a list that starts on it: they never show together, so both keep it", async () => {
    const placed = await place({
      accents: [{ from: "w24", to: "w26" }],
      lists: [{ items: [LIST_AT_W26] }],
    });
    const accent = placed.spans.get("accent-1")!;
    const list = placed.spans.get("transition-1")!;
    // "w26" is shown by both, one after the other: the accent ends where the list
    // comes in (text picks show one at a time), and the list keeps all its words.
    expect(accent).toMatchObject({ start: start("w24") });
    expect(accent.end).toBeLessThanOrEqual(list.start + 1e-6);
    expect(list.start).toBeGreaterThanOrEqual(end("w26") - ENTRANCE - 1e-6);
    expect(list.end).toBe(end("w33"));
    expect(placed.record.filter((note) => note.rule === "same-text")).toEqual([]);
    expect(placed.checks).toEqual([]);
  });

  it("keeps an accent that shows a list's word only after the list ends: they never show together", async () => {
    const placed = await place({
      accents: [{ from: "w30", to: "w31" }],
      lists: [{ items: [LIST_AT_W26] }],
    });
    const accent = placed.spans.get("accent-1")!;
    const list = placed.spans.get("transition-1")!;
    // The list is cut where the accent comes in: the words it no longer shows
    // are captions.
    expect(list.end).toBeLessThanOrEqual(accent.start + 1e-6);
    expect(placed.record.filter((note) => note.rule === "same-text")).toEqual([]);
    expect(placed.checks).toEqual([]);
  });

  it("shows a list's word as a caption again where a big word cuts the list before it", async () => {
    // The big word "completely" starts inside "has" (w27), the list's last word:
    // the list stops before it, so "has" is a caption; the words the list still
    // shows are left out of the captions while it shows.
    const placed = await place({
      lists: [{ items: [{ from: "w22", to: "w27", key_from: "w24" }] }],
      big_words: [{ from: "w28", to: "w28" }],
    });
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "transition-1",
        outcome: "retimed",
        rule: "timing",
      }),
    );
    const has = placed.edit.tracks.captions.find((item) => item.id === "cw27")!;
    expect(has.hidden_by).toBeUndefined();
    expect(has.position).toBeDefined();
    expect(placed.edit.tracks.captions.find((item) => item.id === "cw25")!.hidden_by).toBe(
      "transition-1",
    );
    expect(placed.checks).toEqual([]);
  });

  it("cuts a big word where an accent said in its minimum starts; the accent keeps its own words", async () => {
    const placed = await place({
      big_words: [{ from: "w76", to: "w76" }],
      accents: [{ from: "w77", to: "w78" }],
    });
    const big = placed.spans.get("big-word-1")!;
    const accent = placed.spans.get("accent-1")!;
    // The big word starts at its lead; its minimum is a target, so the accent
    // said inside it cuts it where it starts.
    expect(big.start).toBeCloseTo(leadOf("w76"), 3);
    expect(big.end).toBeCloseTo(start("w77"), 3);
    // The accent is not made to wait: it shows its own words.
    expect(accent.start).toBeCloseTo(start("w77"), 3);
    expect(accent.end).toBeCloseTo(end("w78"), 3);
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "big-word-1",
        outcome: "retimed",
        rule: "timing",
      }),
    );
    expect(placed.checks).toEqual([]);
  });

  it("never cuts a visual for an accent: the visual keeps its own times beside it", async () => {
    const visualOnly = await place({ visuals: [{ from: "w6", to: "w8" }] });
    const placed = await place({
      accents: [{ from: "w5", to: "w6" }],
      visuals: [{ from: "w6", to: "w8" }],
    });
    expect(placed.spans.get("accent-1")).toMatchObject({ start: start("w5"), end: end("w6") });
    expect(placed.spans.get("visual-1")).toMatchObject(visualOnly.spans.get("visual-1")!);
    expect(
      placed.record.filter((note) => note.item === "visual-1" && note.outcome === "retimed"),
    ).toEqual([]);
  });
});

describe("every pick shown, or dropped where another pick shows its text", () => {
  // Eight picks in the first 9 s of the reel, overlapping: four accents (each
  // at least 1.5 s on screen, so they overlap one another), two big words and
  // two visuals.
  const DENSE_TEN: Partial<EngineInput> = {
    accents: [
      { from: "w1", to: "w2" },
      { from: "w3", to: "w4" },
      { from: "w5", to: "w6" },
      { from: "w9", to: "w9" },
    ],
    big_words: [
      { from: "w4", to: "w4" },
      { from: "w9", to: "w9" },
    ],
    visuals: [
      { from: "w6", to: "w8" },
      { from: "w12", to: "w17" },
    ],
  };
  const PICKS: [string, string, string][] = [
    ["accent-1", "w1", "w2"],
    ["accent-2", "w3", "w4"],
    ["accent-3", "w5", "w6"],
    ["big-word-1", "w4", "w4"],
    ["big-word-2", "w9", "w9"],
    ["visual-1", "w6", "w8"],
    ["visual-2", "w12", "w17"],
  ];

  it("shows every pick it keeps from its first word to its last word's end; an accent on screen with a big word that shares its word is dropped", async () => {
    const { edit, spans, record } = await place(DENSE_TEN, {
      headTrack: hand.headTrack,
    });
    expect(edit.tracks.overlays.map((item) => item.id)).toEqual([
      "accent-1",
      "accent-2",
      "accent-3",
    ]);
    expect(edit.tracks.behind?.map((item) => item.id).sort()).toEqual([
      "big-word-1",
      "big-word-2",
      "visual-1",
      "visual-2",
    ]);
    expect(record).toContainEqual(
      expect.objectContaining({ item: "accent-4", outcome: "dropped", rule: "same-text" }),
    );
    expect(parseEdit(edit, ISSEBYA_PRESET, transcript).ok).toBe(true);
    for (const [id, from, to] of PICKS) {
      const span = spans.get(id)!;
      expect(span.end).toBeGreaterThan(span.start);
      if (id.startsWith("visual")) {
        // A visual shows over its own words, from its first word to its last.
        expect(span.start).toBeLessThanOrEqual(byId.get(from)!.start + 1e-6);
        expect(span.end).toBeGreaterThanOrEqual(byId.get(to)!.end - 1e-6);
      }
    }
    // The accents show one at a time, in order.
    const text = ["accent-1", "accent-2", "accent-3"]
      .map((id) => ({ id, ...spans.get(id)! }))
      .sort((a, b) => a.start - b.start);
    for (let index = 1; index < text.length; index += 1) {
      expect(
        text[index]!.start,
        `${text[index - 1]!.id} and ${text[index]!.id}`,
      ).toBeGreaterThanOrEqual(text[index - 1]!.end - 1e-6);
    }
  });

  it("shows a question with the other picks", async () => {
    const { edit, spans } = await place(
      { ...DENSE_TEN, questions: [{ from: "w30", to: "w31" }] },
      { headTrack: hand.headTrack },
    );
    expect(edit.tracks.overlays.map((item) => item.id)).toContain("question-1");
    expect(spans.get("question-1")!.start).toBeLessThanOrEqual(byId.get("w30")!.start + 1e-6);
    expect(parseEdit(edit, ISSEBYA_PRESET, transcript).ok).toBe(true);
  });

  it("drops an accent whose word a big word on screen shows, names both picks, and cuts nothing else", async () => {
    const { record, checks } = await place(DENSE_TEN, {
      headTrack: hand.headTrack,
    });
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "accent-4",
        outcome: "dropped",
        rule: "same-text",
        reason: expect.stringMatching(
          /^accent ".+" is dropped: every word it shows, ".+", is already shown by the big word ".+", a big word keeps the shared words first$/,
        ),
      }),
    );
    expect(
      record.filter((note) => note.rule === "same-text" && note.outcome === "dropped"),
    ).toHaveLength(1);
    expect(checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
    expect(checks.filter((check) => check.rule === "same-text")).toEqual([]);
  });

  it("keeps a big word over an accent on the same word when both show together: the accent is dropped", async () => {
    const placed = await place({
      big_words: [{ from: "w40", to: "w40" }],
      accents: [{ from: "w40", to: "w40" }],
    });
    // Both start on "has": the big word keeps it, the accent has no word left.
    expect(placed.spans.has("accent-1")).toBe(false);
    expect(placed.spans.get("big-word-1")!.start).toBeCloseTo(leadOf("w40"), 3);
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "accent-1",
        outcome: "dropped",
        rule: "same-text",
        reason:
          'accent "has" is dropped: every word it shows, "has", is already shown by the big word "has", a big word keeps the shared words first',
      }),
    );
    expect(placed.checks).toEqual([]);
  });

  it("trims an accent that shares its first word with a big word on screen: the big word keeps the shared word", async () => {
    const placed = await place({
      big_words: [{ from: "w40", to: "w40" }],
      accents: [{ from: "w40", to: "w41" }],
    });
    // The big word's floor holds it on screen past "given"'s start: the accent
    // shows its own word only.
    expect(placed.spans.get("big-word-1")!.start).toBeCloseTo(leadOf("w40"), 3);
    expect(placed.spans.get("accent-1")!.end).toBeCloseTo(end("w41"), 3);
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "accent-1",
        outcome: "retimed",
        rule: "same-text",
        reason:
          'accent "has given" shows only "given", not its shared "has": the big word "has" shows that text, a big word keeps the shared words first',
      }),
    );
    expect(placed.checks).toEqual([]);
  });

  it("keeps both picks that share a word but never show together: a big word that starts as an accent ends", async () => {
    const placed = await place({
      big_words: [{ from: "w40", to: "w40" }],
      accents: [{ from: "w38", to: "w40" }],
    });
    expect(placed.spans.get("accent-1")!.end).toBeLessThanOrEqual(
      placed.spans.get("big-word-1")!.start + 1e-6,
    );
    expect(placed.spans.get("accent-1")).toMatchObject({ start: start("w38") });
    expect(placed.record.filter((note) => note.rule === "same-text")).toEqual([]);
    expect(placed.checks).toEqual([]);
  });

  it("places a visual the face leaves no corner for over the face, noted covers-face", async () => {
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const { edit, record } = await place(
      { visuals: [{ from: "w84", to: "w99" }] },
      { headTrack: huge },
    );
    expect(edit.tracks.behind).toEqual([
      expect.objectContaining({ id: "visual-1", kind: "visual" }),
    ]);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "visual-1",
        outcome: "covers-face",
        rule: "face",
        reason: expect.stringMatching(
          /^visual 1 covers the face from .+ to .+: no spot off the face/,
        ),
      }),
    );
  });

  it("places a big word the head hides at every height where it is, noted", async () => {
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const { edit, record } = await place(
      { big_words: [{ from: "w76", to: "w76" }] },
      { headTrack: huge },
    );
    expect(edit.tracks.behind).toEqual([
      expect.objectContaining({ id: "big-word-1", kind: "word" }),
    ]);
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "big-word-1",
        outcome: "kept-overlapping",
        rule: "text-overlap",
      }),
    );
  });

  it("shows a transition that runs during the hook: the hook keeps its window", async () => {
    const placed = await place(
      {
        hook: { text: "Gen Z won't work like you did" },
        lists: [
          {
            items: [
              { from: "w4", to: "w9", key_from: "w6" },
              { from: "w26", to: "w33", key_from: "w30" },
            ],
          },
        ],
      },
      { headTrack: hand.headTrack },
    );
    expect(placed.edit.tracks.transitions.map((item) => item.id)).toEqual([
      "transition-1",
      "transition-2",
    ]);
    expect(placed.edit.tracks.overlays.map((item) => item.id)).toEqual(["hook"]);
  });
});

// The engine drops nothing the answer picks: a 1 s reel (a number and its
// unit, a last word at the reel's end), a footage cut over the second word.
const ONE_SECOND: Transcript = {
  words: [
    { id: "w1", text: "Hello", start: 0.05, end: 0.3 },
    { id: "w2", text: "there", start: 0.35, end: 0.6 },
    { id: "w3", text: "5", start: 0.62, end: 0.7 },
    { id: "w4", text: "years", start: 0.72, end: 0.85 },
    { id: "w5", text: "friend", start: 0.9, end: 0.98 },
  ],
};

function oneSecondReel(): Edit {
  const base = baselineEdit(
    ONE_SECOND,
    { inputs: baselineInputs().inputs, duration: 1 },
    ISSEBYA_PRESET,
  );
  return {
    ...base,
    tracks: {
      ...base.tracks,
      footage: [
        {
          id: "footage",
          start: { reel: "start" },
          end: { reel: "end" },
          hidden: [{ start: { time: 0.2 }, end: { time: 0.45 } }],
        },
      ],
    },
  };
}

describe("nothing the answer picks is dropped", () => {
  it("shows a pick at the reel's end, a pick over a cut, a transition with no text and a hook on a 1 s reel", async () => {
    const { edit, record } = await place(
      {
        accents: [{ from: "w5", to: "w5" }],
        big_words: [{ from: "w2", to: "w2" }],
        lists: [{ items: [{ from: "w4", to: "w4", key_from: "w4" }] }],
        hook: { text: "Hello there" },
      },
      { current: oneSecondReel(), transcript: ONE_SECOND },
    );
    expect(edit.tracks.overlays.map((item) => item.id)).toEqual(["hook", "accent-1"]);
    expect(edit.tracks.transitions.map((item) => item.id)).toEqual(["transition-1"]);
    expect(edit.tracks.behind?.map((item) => item.id)).toEqual(["big-word-1"]);
    expect(parseEdit(edit, ISSEBYA_PRESET, ONE_SECOND).ok).toBe(true);
    // The accent shows exactly its word, so it is never shown from earlier.
    expect(record).not.toContainEqual(
      expect.objectContaining({ item: "accent-1", outcome: "retimed" }),
    );
    expect(record).toContainEqual(
      expect.objectContaining({ item: "big-word-1", outcome: "retimed" }),
    );
    // The list's phrase is its own caption's word now: the key shows it.
    expect(edit.tracks.transitions[0]!.levels?.key.text).toBeTruthy();
    expect(record).not.toContainEqual(
      expect.objectContaining({ item: "accent-1", outcome: "kept-overlapping" }),
    );
  });

  it("drops a pick only where an earlier pick shows its words, for random sets of picks", async () => {
    // A seeded generator: the same sets on every run.
    let seed = 20261108;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const count = (most: number) => Math.floor(random() * (most + 1));
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const ids = words.map((word) => word.id);
    // A run of words: from a random word, up to `longest` words on.
    const run = (longest: number): [string, string] => {
      const at = Math.floor(random() * ids.length);
      const to = Math.min(ids.length - 1, at + Math.floor(random() * (longest + 1)));
      return [ids[at]!, ids[to]!];
    };
    for (let round = 0; round < 25; round += 1) {
      const input: Partial<EngineInput> = {
        accents: Array.from({ length: count(5) }, () => {
          const [from, to] = run(6);
          return { from, to };
        }),
        big_words: Array.from({ length: count(4) }, () => {
          const id = pick(ids);
          return { from: id, to: id };
        }),
        visuals: Array.from({ length: count(3) }, () => {
          const [from, to] = run(12);
          return { from, to };
        }),
        lists: [
          {
            items: Array.from({ length: count(3) }, () => {
              const [from, to] = run(8);
              return { from, to, key_from: from };
            }),
          },
        ],
        hook: random() < 0.5 ? { text: "Gen Z won't work like you did" } : null,
      };
      const { edit, record, checks } = await place(input);
      const shown = [
        ...edit.tracks.overlays.map((item) => item.id),
        ...(edit.tracks.behind ?? []).map((item) => item.id),
      ];
      // A text pick is shown, or dropped by the same-text rule (noted).
      const dropped = (id: string) =>
        record.some(
          (note) => note.item === id && note.outcome === "dropped" && note.rule === "same-text",
        );
      const texts = [
        ...(input.accents ?? []).map((_, index) => `accent-${index + 1}`),
        ...(input.big_words ?? []).map((_, index) => `big-word-${index + 1}`),
      ];
      for (const id of texts) {
        expect(shown.includes(id) !== dropped(id), `round ${round} ${id}`).toBe(true);
      }
      (input.visuals ?? []).forEach((_, index) =>
        expect(shown, `round ${round}`).toContain(`visual-${index + 1}`),
      );
      const transitions = (input.lists ?? [])
        .flatMap((list) => list.items)
        .map((_, index) => `transition-${index + 1}`);
      expect(
        edit.tracks.transitions.map((item) => item.id),
        `round ${round}`,
      ).toEqual(transitions.filter((id) => !dropped(id)));
      expect(shown.includes("hook"), `round ${round}`).toBe(input.hook !== null);
      expect(
        checks.filter((check) => check.rule === "same-text"),
        `round ${round}`,
      ).toEqual([]);
    }
  });
});

// A caption-heavy opening: the first `count` words of the reel as a caption
// each, in the first 3 s, and the rest of the reel after them.
// The same edit with no captions: the components' first choices, placed alone.
function withoutCaptions(edit: Edit): Edit {
  return { ...edit, tracks: { ...edit.tracks, captions: [] } };
}

// The big word's place in a placed edit's behind track.
function wordPosition(placed: { edit: Edit }) {
  return placed.edit.tracks.behind?.find((item) => item.kind === "word")?.position;
}

function denseOpening(count: number): { current: Edit; transcript: Transcript } {
  const dense = words.slice(0, count).map((word, index) => ({
    id: word.id,
    text: (index + 1) % 2 === 0 ? `${word.text}.` : word.text,
    start: 0.2 + index * 0.05,
    end: 0.2 + index * 0.05 + 0.045,
  }));
  const spoken = {
    words: [
      ...dense,
      ...words.slice(count).map((word) => ({ ...word, start: word.start + 3, end: word.end + 3 })),
    ],
  };
  const current = {
    ...hand.edit,
    tracks: {
      ...hand.edit.tracks,
      captions: dense.map((word, index) => ({
        id: `cw${index}`,
        start: { word: word.id },
        end: { word: word.id, edge: "end" as const },
        words: [word.id],
        size: 50,
        position: { x: 100, y: 300, align: "left" as const },
      })),
      overlays: [],
      lists: [],
      behind: [],
      sounds: [],
    },
  };
  return { current, transcript: spoken };
}

// Seeded random picks over a reel's word ids: the same sets on every run.
function seededPicks(seed: number, ids: readonly string[], rounds: number): EngineInput[] {
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const count = (most: number) => Math.floor(random() * (most + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const run = (longest: number): [string, string] => {
    const at = Math.floor(random() * ids.length);
    const to = Math.min(ids.length - 1, at + Math.floor(random() * (longest + 1)));
    return [ids[at]!, ids[to]!];
  };
  return Array.from({ length: rounds }, () => ({
    ...NOTHING,
    accents: Array.from({ length: count(5) }, () => {
      const [from, to] = run(6);
      return { from, to };
    }),
    big_words: Array.from({ length: count(4) }, () => {
      const id = pick(ids);
      return { from: id, to: id };
    }),
    visuals: Array.from({ length: count(3) }, () => {
      const [from, to] = run(12);
      return { from, to };
    }),
    lists: [
      {
        items: Array.from({ length: count(3) }, () => {
          const [from, to] = run(8);
          return { from, to, key_from: from };
        }),
      },
    ],
    hook: random() < 0.5 ? { text: "Gen Z won't work like you did" } : null,
  }));
}

describe("texts never overlap on screen while a free spot exists", () => {
  // The rule's gaps, closed: a big word placed after the captions (it kept the
  // place of the head rule over them), an accent and the hook kept over other
  // text where the face was the only obstacle, a caption set over text.
  it("never overlaps two texts in random picks over the fixture reel", async () => {
    const ids = words.map((word) => word.id);
    for (const [round, input] of seededPicks(20261109, ids, 30).entries()) {
      const placed = await place(input);
      expect(
        placed.checks.filter((check) => check.rule === "text-overlap"),
        `round ${round}`,
      ).toEqual([]);
    }
  });

  it("never overlaps two texts in random picks over a caption-heavy opening", async () => {
    const { current, transcript: spoken } = denseOpening(60);
    const ids = spoken.words.map((word) => word.id);
    for (const [round, input] of seededPicks(20261110, ids, 12).entries()) {
      const placed = await place(input, { current, transcript: spoken, headTrack: BIG_FACE });
      expect(
        placed.checks.filter((check) => check.rule === "text-overlap"),
        `round ${round}`,
      ).toEqual([]);
    }
  });

  it("never shows one spoken word twice on screen in random picks over the fixture reel", async () => {
    const ids = words.map((word) => word.id);
    for (const [round, input] of seededPicks(20261112, ids, 30).entries()) {
      const placed = await place(input);
      expect(
        placed.checks.filter((check) => check.rule === "same-text"),
        `round ${round}`,
      ).toEqual([]);
    }
  });

  it("never shows one spoken word twice on screen in random picks over a caption-heavy opening", async () => {
    const { current, transcript: spoken } = denseOpening(60);
    const ids = spoken.words.map((word) => word.id);
    for (const [round, input] of seededPicks(20261113, ids, 12).entries()) {
      const placed = await place(input, { current, transcript: spoken, headTrack: BIG_FACE });
      expect(
        placed.checks.filter((check) => check.rule === "same-text"),
        `round ${round}`,
      ).toEqual([]);
    }
  });

  it("places a big word at its first choice before the captions, and the captions move around it", async () => {
    // Over the captions of the opening the word has a clear place at its size;
    // the captions are placed after it now, so the word keeps the place it has
    // with no captions at all, and none of the captions sits on it.
    const { current, transcript: spoken } = denseOpening(60);
    const input = { big_words: [{ from: "w20", to: "w20" }] };
    const placed = await place(input, { current, transcript: spoken, headTrack: BIG_FACE });
    const alone = await place(input, {
      current: withoutCaptions(current),
      transcript: spoken,
      headTrack: BIG_FACE,
    });
    expect(placed.checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
    expect(wordPosition(placed)).toEqual(wordPosition(alone));
    expect(placed.record.filter((note) => note.item === "big-word-1")).not.toContainEqual(
      expect.objectContaining({ outcome: "moved", rule: "zone" }),
    );
    expect(
      placed.record.some((note) => note.outcome === "kept-overlapping" && note.blockers.length > 0),
    ).toBe(false);
  });

  it("keeps a big word clear of the captions of its own sentence, the word it shows left out of them", async () => {
    // "we" in the fixture reel: its captions' rest sit clear of the word (the
    // old place overlapped them by 8 px), its own word is left out of them.
    const placed = await place({ big_words: [{ from: "w113", to: "w113" }] });
    expect(placed.checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
    expect(placed.edit.tracks.captions.find((caption) => caption.id === "cw113")!.hidden_by).toBe(
      "big-word-1",
    );
    expectNoWordTwice(placed.edit, placed.spans);
  });

  it("notes a text starting inside a cut hook's floor as sharing its time with the hook", async () => {
    // The accent starts with the hook, which the one-at-a-time rule cuts to no
    // length: it shows the floor over the accent, and the accent's note names it.
    const placed = await place({
      hook: { text: "Gen Z won't work like you did" },
      accents: [{ from: "w0", to: "w1" }],
    });
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "hook",
        outcome: "retimed",
        rule: "timing",
      }),
    );
    expect(placed.record).toContainEqual(
      expect.objectContaining({
        item: "accent-1",
        outcome: "kept-overlapping",
        blockers: [{ kind: "item", id: "hook" }],
      }),
    );
    expect(placed.checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
  });
});

describe("captions take the space the components leave", () => {
  it("keeps a visual at its first card spot, as with no captions at all, and the captions go round it", async () => {
    const input: Partial<EngineInput> = {
      visuals: REQUEST_ANSWER.visuals,
      lists: REQUEST_ANSWER.lists,
    };
    const placed = await place(input, { headTrack: LEFT_HEAD });
    const alone = await place(input, {
      headTrack: LEFT_HEAD,
      current: withoutCaptions(hand.edit),
    });
    expect(placed.edit.tracks.behind?.find((item) => item.kind === "visual")!.box).toEqual(
      alone.edit.tracks.behind?.find((item) => item.kind === "visual")!.box,
    );
    expect(placed.record).not.toContainEqual(
      expect.objectContaining({ item: "visual-1", outcome: "moved", rule: "contrast" }),
    );
    expect(placed.checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
  });
});

describe("text kept over text only where no free spot exists", () => {
  it("places an accent at its first choice before the captions: the caption it would sit on moves", async () => {
    // The numbered list's text shares the time of its sentence's captions. The
    // accent is placed before them, so it keeps the place it has with no
    // captions at all, and the sentence's captions move around it: nothing
    // overlaps, nothing is noted for the accent.
    const input = {
      accents: [{ from: "w27", to: "w33" }],
      lists: [{ items: [{ from: "w52", to: "w53", key_from: "w52" }] }],
    };
    const placed = await place(input);
    const alone = await place(input, { current: withoutCaptions(hand.edit) });
    expect(placed.edit.tracks.overlays.find((item) => item.id === "accent-1")!.position).toEqual(
      alone.edit.tracks.overlays.find((item) => item.id === "accent-1")!.position,
    );
    expect(placed.record.filter((note) => note.item === "accent-1")).not.toContainEqual(
      expect.objectContaining({ outcome: "kept-overlapping" }),
    );
    expect(placed.checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
  });
});
