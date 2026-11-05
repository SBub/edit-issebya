import { describe, expect, it } from "vitest";
import { type Backgrounds, backgroundSampler } from "./background.ts";
import { bigWordCoveredShare, maskSpans } from "./behind.ts";
import { build } from "./build.ts";
import { editFromAnswer } from "./decide.ts";
import { type PhotoLook, placeEdit } from "./engine.ts";
import { type EngineInput, choicesOf } from "./engine-input.ts";
import { type HeadTrack, facesOver } from "./head-track.ts";
import { ISSEBYA_PRESET, PLATFORM_BUTTONS, PLATFORM_SAFE, TRANSITION_KINDS } from "./preset.ts";
import { type Edit, parseEdit } from "./schema.ts";
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
  big_words: [],
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
    photos,
  }: {
    headTrack?: HeadTrack;
    current?: Edit;
    backgrounds?: Backgrounds;
    // The library photos' ratios and edge luminances.
    photos?: ReadonlyMap<string, PhotoLook>;
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
    photos,
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

// Never the same word twice on screen: every caption an accent or a big word
// hides shares a word and some time with it; every caption still shown
// shares no word with an accent or big word shown at the same time.
function expectNoWordTwice(edit: Edit, spans: ReturnType<typeof resolveTimeline>): void {
  const showing = [
    ...edit.tracks.overlays.map((item) => ({ id: item.id, words: item.words ?? [] })),
    ...(edit.tracks.behind ?? []).flatMap((item) =>
      item.kind === "word" ? [{ id: item.id, words: [(item.start as { word: string }).word] }] : [],
    ),
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

  it("shows an accent from the lead before its first word to a second after its last, at least 1.5 s", async () => {
    const { spans, edit } = await place({
      accents: [
        { from: "w29", to: "w29", title: false },
        { from: "w84", to: "w87", title: false },
      ],
    });
    const one = spans.get("accent-1")!;
    expect(one.start).toBe(leadOf("w29"));
    expect(edit.tracks.overlays[0]!.start).toEqual({ word: "w29", offset: -LEAD });
    expect(one.end - one.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
    const two = spans.get("accent-2")!;
    expect(two.start).toBe(leadOf("w84"));
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

  it("shows a big word on the accent's timing: the lead before its word to a second after it", async () => {
    const { spans, edit } = await place({ big_words: [{ word: "w76" }] });
    const span = spans.get("big-word-1")!;
    const said = byId.get("w76")!;
    expect(span.start).toBe(leadOf("w76"));
    const sentence = sentences.find((s) => s.from === "w63")!;
    expect(sentence.end).toBeGreaterThan(span.end + 0.5);
    expect(span.end).toBeCloseTo(Math.max(said.end + 1, span.start + 1.5), 3);
    expect(edit.tracks.behind![0]).toMatchObject({
      kind: "word",
      text: "distribution",
      start: { word: "w76", offset: -LEAD },
    });
  });

  it("gives up the lead rather than cut the extra before it", async () => {
    // "AI has completely" leaves at 9.607 s, a second after "completely";
    // "work" is said at 9.789 s, so its lead would start at 9.589 s. The big
    // word comes in as the accent leaves, the accent keeps its time and the
    // big word still shows 1.5 s.
    const { spans, record } = await place({
      accents: [{ from: "w26", to: "w28", title: false }],
      big_words: [{ word: "w33" }],
    });
    const accent = spans.get("accent-1")!;
    const word = spans.get("big-word-1")!;
    expect(accent.end).toBeCloseTo(byId.get("w28")!.end + 1, 3);
    expect(word.start).toBeCloseTo(accent.end, 3);
    expect(word.start).toBeGreaterThan(leadOf("w33"));
    expect(word.end - word.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
    expect(record.filter((note) => note.item === "accent-1" && note.rule === "one-extra")).toEqual(
      [],
    );
  });

  it("shows several big words, the same word again too, each on the accent's timing", async () => {
    // "work" is said at w33 and again at w126.
    const choices = [{ word: "w33" }, { word: "w76" }, { word: "w126" }];
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
      const said = byId.get(choices[index]!.word)!;
      expect(span.start).toBe(leadOf(said.id));
      expect(span.end - span.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
      expect(span.end).toBeLessThanOrEqual(Math.max(said.end + 1, span.start + 1.5) + 1e-6);
    });
    expect(checks).toEqual([]);
  });

  it("shows a photo from its sentence's start, 1 to 2 s, never into the next sentence", async () => {
    // "We have it all." and its pauses last 0.9 s: the photo would cross
    // into another sentence, so it is dropped.
    const short = await place({ photos: [{ photo_id: PHOTO, from: "w113", to: "w116" }] });
    expect(short.edit.tracks.behind).toBeUndefined();
    expect(short.record).toContainEqual(
      expect.objectContaining({ item: "photo-1", action: "dropped", rule: "photo-time" }),
    );
    // A sentence of 3.2 s: from its start, leaving after 2 s.
    const whole = await place({ photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }] });
    const span = whole.spans.get("photo-1")!;
    const sentence = sentences.find((s) => s.from === "w84")!;
    expect(span.start).toBe(sentence.start);
    expect(span.end).toBeCloseTo(sentence.start + 2, 3);
    // A long sentence, photo words late in it: from its first word, 2 s.
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
      big_words: [{ word: "w66" }],
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
      expect.objectContaining({ item: "big-word-1", action: "dropped", rule: "one-extra" }),
    );
  });

  it("places the items the request is about before the other extras", async () => {
    const measurer = await nodeMeasurer();
    const input: EngineInput = {
      ...NOTHING,
      accents: [{ from: "w66", to: "w67", title: false }],
      big_words: [{ word: "w66" }],
    };
    const asked = placeEdit(
      hand.edit,
      input,
      transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      measurer,
      {
        requested: ["big_words[0]"],
      },
    );
    expect(asked.tracks.behind?.map((item) => item.id)).toEqual(["big-word-1"]);
    expect(asked.tracks.overlays).toEqual([]);
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
      accents: [{ from: "w110", to: "w112", title: false }],
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
    const captionNotes = (notes: { item: string }[]) =>
      notes.filter((note) => note.item.startsWith("cw"));
    expect(captionNotes(record)).toEqual(captionNotes(plain.record));
    expectNoWordTwice(edit, spans);
  });

  it('leaves the big word out of its caption: "it to the world" reads "it to the"', async () => {
    const { edit, spans, checks } = await place({ big_words: [{ word: "w62" }] });
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
      accents: [{ from: "w117", to: "w122", title: false }],
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
      /caption cw\d+: hidden by accent-9, which is no accent or big word/,
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

  it("moves a short big word up so the head covers at most 30% of it", async () => {
    const measurer = await nodeMeasurer();
    const { edit, spans, checks, record } = await place(
      { big_words: [{ word: "w116" }] },
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
    expect(
      bigWordCoveredShare(box, facesOver(BIG_FACE, span.start, span.end), ISSEBYA_PRESET),
    ).toBeLessThanOrEqual(maxCovered + 1e-6);
    // Above the head's top, only its lower part behind it, never above the
    // platforms' safe top.
    expect(box.top).toBeGreaterThanOrEqual(PLATFORM_SAFE.top);
    expect(box.top).toBeLessThan(452);
    expect(record).toContainEqual(
      expect.objectContaining({ item: word.id, action: "moved", rule: "big-word-visible" }),
    );
  });

  it("shrinks, then drops, a big word the head hides at every place under the safe top", async () => {
    // A wide head right under the safe zone's top: no room above it.
    const high = steadyHead({ head_top: 270, cx: 540, head_w: 700 });
    const { edit, record, checks, unplaced } = await place(
      { big_words: [{ word: "w116" }] },
      { headTrack: high },
    );
    expect(checks).toEqual([]);
    expect(edit.tracks.behind).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({ item: "big-word-1", action: "dropped", rule: "big-word-visible" }),
    );
    expect(unplaced).toMatchObject([{ ref: "big_words[0]", why: "no-room" }]);
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
    big_words: [{ word: "w76" }],
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

  // The Medium rhythm: an extra on every sentence (accents, big words and
  // photos in turn, several of each, the same photo again) and two
  // transitions, far more than fits.
  const RHYTHM: Partial<EngineInput> = { accents: [], big_words: [], photos: [] };
  sentences.forEach((sentence, index) => {
    const from = words.findIndex((word) => word.id === sentence.from);
    const to = words.findIndex((word) => word.id === sentence.to);
    const ids = words.slice(from, to + 1).map((word) => word.id);
    const longest = [...ids].sort(
      (a, b) => byId.get(b)!.text.length - byId.get(a)!.text.length || a.localeCompare(b),
    )[0]!;
    if (index % 3 === 0) {
      RHYTHM.accents!.push({ from: ids[0]!, to: ids[Math.min(2, ids.length - 1)]!, title: false });
    } else if (index % 3 === 1) {
      RHYTHM.big_words!.push({ word: longest });
    } else {
      const photo = RHYTHM.photos!.length % 2 === 0 ? PHOTO : OTHER_PHOTO;
      RHYTHM.photos!.push({ photo_id: photo, from: sentence.from, to: sentence.to });
    }
  });
  RHYTHM.transitions = [
    { kind: "dim", from: "w26", to: "w33", key_from: "w30" },
    { kind: "panel", from: "w126", to: "w133", key_from: "w128" },
  ];

  for (const [name, headTrack] of [
    ["the real head", hand.headTrack],
    ["a large centred face", BIG_FACE],
  ] as const) {
    it(`keeps the calm rules with an extra on every sentence and ${name}`, async () => {
      const { edit, spans, checks, record, unplaced } = await place(RHYTHM, { headTrack });
      expect(checks).toEqual([]);
      // One extra at a time, none during a transition.
      const extras = extrasOf(edit).map((item) => spans.get(item.id)!);
      const running = edit.tracks.transitions.map((item) => spans.get(item.id)!);
      for (const [index, a] of extras.entries()) {
        for (const b of [...extras.slice(index + 1), ...running]) {
          expect(a.end <= b.start + 1e-6 || b.end <= a.start + 1e-6).toBe(true);
        }
      }
      // Photos last 1 to 2 s; big words the accent's timing, at least
      // 1.5 s and at most a second after their word.
      for (const item of edit.tracks.behind ?? []) {
        const span = spans.get(item.id)!;
        if (item.kind === "photo") {
          expect(span.end - span.start).toBeGreaterThanOrEqual(1 - 1e-6);
          expect(span.end - span.start).toBeLessThanOrEqual(2 + 1e-6);
        } else {
          const said = byId.get((item.start as { word: string }).word)!;
          expect(span.end - span.start).toBeGreaterThanOrEqual(1.5 - 1e-6);
          expect(span.end).toBeLessThanOrEqual(Math.max(said.end + 1, span.start + 1.5) + 1e-6);
        }
      }
      expectNoWordTwice(edit, spans);
      // Many still show, and every one left out has its drop in the record.
      expect(extras.length).toBeGreaterThanOrEqual(6);
      for (const item of unplaced) {
        expect(
          record.some((note) => note.item === item.id && note.action === "dropped"),
          item.ref,
        ).toBe(true);
      }
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
      { big_words: [{ word: "w76" }] },
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
    const { checks, edit } = await place({ big_words: [{ word: "w76" }] }, { headTrack: BIG_FACE });
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

describe("photos behind or in front of the speaker", () => {
  const spec = ISSEBYA_PRESET.behind.photo;
  const maxCovered = 1 - spec.minVisible;
  // A wide, high head: its body spans the frame's middle, so no box behind it
  // keeps 70% in view; in front there is room below the face.
  const WIDE = steadyHead({ head_top: 250, cx: 540, head_w: 420 });
  const photosOf = (edit: Edit) =>
    (edit.tracks.behind ?? []).flatMap((item) => (item.kind === "photo" ? [item] : []));
  const boxOf = (item: { box?: { x: number; y: number; width: number; height: number } }) => ({
    left: item.box!.x,
    right: item.box!.x + item.box!.width,
    top: item.box!.y,
    bottom: item.box!.y + item.box!.height,
  });

  it("puts a photo behind the speaker high in the frame, at most its lower 30% behind them", async () => {
    const { edit, spans, checks, record, html } = await place({
      photos: [{ photo_id: PHOTO, from: "w84", to: "w99", reason: "match" }],
    });
    expect(checks).toEqual([]);
    const [photo] = photosOf(edit);
    expect(photo).toMatchObject({ id: "photo-1", layer: "behind", spot: "top" });
    const box = boxOf(photo!);
    const span = spans.get("photo-1")!;
    expect(
      bigWordCoveredShare(box, facesOver(hand.headTrack, span.start, span.end), ISSEBYA_PRESET),
    ).toBeLessThanOrEqual(maxCovered + 1e-6);
    // Inside the platforms' safe zone, in its upper part.
    expect(box.top).toBeGreaterThanOrEqual(PLATFORM_SAFE.top);
    expect(box.left).toBeGreaterThanOrEqual(PLATFORM_SAFE.left);
    expect(box.right).toBeLessThanOrEqual(PLATFORM_SAFE.right);
    expect(box.top).toBeLessThan(ISSEBYA_PRESET.frame.height / 2);
    // Its long side a preset size (the larger ones would go behind the head),
    // the default ratio kept.
    expect(Math.max(photo!.box!.width, photo!.box!.height)).toBe(spec.sizes.small);
    expect(photo!.box!.width / photo!.box!.height).toBeCloseTo(spec.aspect, 2);
    expect(record.filter((note) => note.item === "photo-1")).toEqual([
      {
        item: "photo-1",
        action: "shrunk",
        rule: "photo-size",
        reason: `photo 1 set small (460 px) instead of large (860 px): no room for it larger from ${span.start.toFixed(2)} s to ${span.end.toFixed(2)} s`,
      },
    ]);
    // Behind: drawn in the cut-out composite.
    expect(maskSpans(edit, transcript, ISSEBYA_PRESET)).toHaveLength(1);
    expect(html).toMatch(
      /<div id="cut_1" class="cutout">\n {8}<video[^>]*><\/video>\n {8}<img id="photo-1"/,
    );
  });

  it("puts it in front, clear of the face, when no place behind keeps 70% of it in view", async () => {
    const { edit, spans, checks, record, html } = await place(
      { photos: [{ photo_id: PHOTO, from: "w84", to: "w99", reason: "mood" }] },
      { headTrack: WIDE },
    );
    expect(checks).toEqual([]);
    const [photo] = photosOf(edit);
    expect(photo).toMatchObject({ id: "photo-1", layer: "front" });
    const span = spans.get("photo-1")!;
    for (const face of facesOver(WIDE, span.start, span.end)) {
      const box = boxOf(photo!);
      expect(
        box.left < face.right &&
          face.left < box.right &&
          box.top < face.bottom &&
          face.top < box.bottom,
      ).toBe(false);
    }
    expect(record).toContainEqual({
      item: "photo-1",
      action: "moved",
      rule: "photo-layer",
      reason: `photo 1 sits in front: no place behind you keeps 70% of it in view from ${span.start.toFixed(2)} s to ${span.end.toFixed(2)} s`,
    });
    // In front: no cut-out at all, the photo over the footage.
    expect(maskSpans(edit, transcript, ISSEBYA_PRESET)).toEqual([]);
    expect(html).not.toContain('class="cutout"');
    expect(html).toMatch(/<img id="photo-1" class="clip photo"[^>]*data-track-index="30"/);
  });

  it("keeps the owner's front wish, and says when a behind wish cannot be kept", async () => {
    const front = await place(
      { photos: [{ photo_id: PHOTO, from: "w84", to: "w99", wish: "front" }] },
      { requested: ["photos[0]"] },
    );
    expect(front.checks).toEqual([]);
    expect(photosOf(front.edit)).toEqual([expect.objectContaining({ layer: "front" })]);
    expect(front.record.filter((note) => note.rule === "wish")).toEqual([]);
    const behind = await place(
      { photos: [{ photo_id: PHOTO, from: "w84", to: "w99", wish: "behind" }] },
      { headTrack: WIDE, requested: ["photos[0]"] },
    );
    expect(photosOf(behind.edit)).toEqual([expect.objectContaining({ layer: "front" })]);
    expect(behind.record).toContainEqual(
      expect.objectContaining({
        item: "photo-1",
        action: "wish-not-kept",
        rule: "wish",
        reason: expect.stringMatching(
          /^photo 1 sits in front, not behind you as asked: no place behind you keeps 70% of it in view from /,
        ),
      }),
    );
  });

  it("varies the sizes across the reel and keeps each photo's ratio", async () => {
    const looks = new Map([
      [PHOTO, { aspect: 4 / 3 }],
      [OTHER_PHOTO, { aspect: 3 / 4 }],
    ]);
    const { edit, checks } = await place(
      {
        photos: [
          { photo_id: PHOTO, from: sentences[0]!.from, to: sentences[0]!.to },
          { photo_id: OTHER_PHOTO, from: sentences[1]!.from, to: sentences[1]!.to },
          { photo_id: PHOTO, from: sentences[2]!.from, to: sentences[2]!.to },
        ],
      },
      { headTrack: LEFT_HEAD, photos: looks },
    );
    expect(checks).toEqual([]);
    const placed = photosOf(edit);
    expect(placed.length).toBeGreaterThanOrEqual(2);
    const sizes = Object.values(spec.sizes);
    for (const photo of placed) {
      const { width, height } = photo.box!;
      expect(sizes).toContain(Math.max(width, height));
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(spec.minShortSide);
      const aspect = looks.get(photo.photo_id)!.aspect;
      expect(width / height).toBeCloseTo(aspect, 1);
    }
    for (let index = 1; index < placed.length; index += 1) {
      expect(Math.max(placed[index]!.box!.width, placed[index]!.box!.height)).not.toBe(
        Math.max(placed[index - 1]!.box!.width, placed[index - 1]!.box!.height),
      );
    }
  });

  it("moves a photo that blends with the footage, else keeps it plain and records it", async () => {
    const FRAME = ISSEBYA_PRESET.frame;
    const light = new Map([[PHOTO, { edge: 0.8 }]]);
    const input = { photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }] };
    const plain = await place(input);
    const first = boxOf(photosOf(plain.edit)[0]!);
    // A light wall around where it would sit, dark everywhere else.
    const wall = backgroundSampler(
      backgroundMapOf(FRAME, hand.edit.duration, (x, y) =>
        x >= first.left - 60 && x < first.right + 60 && y < first.bottom + 60
          ? "#E8E8E8"
          : "#202020",
      ),
      FRAME,
    );
    const moved = await place(input, { backgrounds: wall, photos: light });
    expect(moved.checks).toEqual([]);
    expect(moved.record).toContainEqual(
      expect.objectContaining({ item: "photo-1", action: "moved", rule: "contrast-spot" }),
    );
    expect(boxOf(photosOf(moved.edit)[0]!)).not.toEqual(first);
    // Light everywhere: it stays, with no frame, edge or shadow.
    const allLight = backgroundSampler(
      backgroundMapOf(FRAME, hand.edit.duration, () => "#E8E8E8"),
      FRAME,
    );
    const kept = await place(input, { backgrounds: allLight, photos: light });
    expect(boxOf(photosOf(kept.edit)[0]!)).toEqual(first);
    expect(kept.record).toContainEqual({
      item: "photo-1",
      action: "low-contrast",
      rule: "contrast-stay",
      reason: expect.stringMatching(
        /^photo 1 stays in place: contrast 1\.\d:1 against the footage around it from .+, no free place nearby reaches 1\.5:1; a photo never gets a frame, an edge or a shadow$/,
      ),
    });
    expect(kept.html).not.toMatch(/<img id="photo-1"[^>]*(shadow|border|outline)/);
    // Without its edge luminance nothing is measured.
    const unknown = await place(input, { backgrounds: allLight });
    expect(
      unknown.record.filter((note) => note.item === "photo-1" && note.rule.startsWith("contrast-")),
    ).toEqual([]);
  });
});

describe("clicks on photos and big words", () => {
  it("clicks as each placed photo and big word comes in, and nothing else", async () => {
    const { edit, spans, checks, html } = await place(
      {
        accents: [{ from: "w26", to: "w28", title: false }],
        big_words: [{ word: "w116" }],
        photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }],
        transitions: [{ kind: "panel", from: "w126", to: "w133", key_from: "w128" }],
      },
      { headTrack: LEFT_HEAD },
    );
    expect(checks).toEqual([]);
    const behind = edit.tracks.behind ?? [];
    expect(behind.map((item) => item.id).sort()).toEqual(["big-word-1", "photo-1"]);
    // The hand edit's own click is not kept: the sounds are the engine's.
    expect(edit.tracks.sounds.map((sound) => sound.id)).toEqual([
      "click-photo-1",
      "click-big-word-1",
    ]);
    for (const sound of edit.tracks.sounds) {
      const item = behind.find((entry) => `click-${entry.id}` === sound.id)!;
      expect(sound.start).toEqual(item.start);
      expect(spans.get(sound.id)!.start).toBeCloseTo(spans.get(item.id)!.start, 6);
    }
    // The big word's click on its lead, 0.2 s before its word.
    expect(spans.get("click-big-word-1")!.start).toBeCloseTo(byId.get("w116")!.start - 0.2, 3);
    expect(html).toMatch(/<audio id="click-photo-1" class="clip" [^>]*data-volume="0\.5012">/);
  });

  it("drops a click with its item, and has none without photos or big words", async () => {
    const huge = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const dropped = await place(
      { photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }] },
      { headTrack: huge },
    );
    expect(dropped.edit.tracks.behind).toBeUndefined();
    expect(dropped.edit.tracks.sounds).toEqual([]);
    const none = await place({ accents: [{ from: "w26", to: "w28", title: false }] });
    expect(none.edit.tracks.sounds).toEqual([]);
  });

  it("follows an item retimed by the one-at-a-time rule", async () => {
    // The photo's sentence also opens with a big word: whichever shows, the
    // click sits on its own start.
    const { edit, spans } = await place(
      {
        big_words: [{ word: "w85" }],
        photos: [{ photo_id: PHOTO, from: "w84", to: "w99" }],
      },
      { headTrack: LEFT_HEAD },
    );
    for (const item of edit.tracks.behind ?? []) {
      expect(spans.get(`click-${item.id}`)!.start).toBeCloseTo(spans.get(item.id)!.start, 6);
    }
    expect(edit.tracks.sounds).toHaveLength((edit.tracks.behind ?? []).length);
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
    expect(record.filter((entry) => entry.action === "low-contrast")).toEqual([]);
    expect(checks).toEqual([]);
  });

  it("keeps the place, plain, when no free place nearby reads: never a shadow, only a note", async () => {
    const before = await place({});
    for (const color of [BEIGE, "#8A8A8A"]) {
      const { edit, record, checks } = await place({}, { backgrounds: mapOf(() => color) });
      expect(edit.tracks.captions.map((caption) => caption.position)).toEqual(
        before.edit.tracks.captions.map((caption) => caption.position),
      );
      for (const caption of edit.tracks.captions) {
        expect(caption.shadow).toBeUndefined();
        expect(caption.color).toBeUndefined();
      }
      const notes = record.filter((entry) => entry.rule === "contrast-stay");
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0]!.action).toBe("low-contrast");
      expect(notes[0]!.reason).toMatch(
        /^captions ".+" stay in place: contrast \d\.\d:1 from .* no free place nearby reaches 4\.5:1$/,
      );
      expect(record.filter((entry) => entry.rule === "contrast-spot")).toEqual([]);
      expect(record.filter((entry) => entry.action === "shadowed")).toEqual([]);
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
    expect(moved.shadow).toBeUndefined();
    expect(moved.color).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({ item: "accent-1", action: "moved", rule: "contrast-spot" }),
    );
    expect(checks).toEqual([]);
  });

  it("keeps the accent in place, plain, when beige is all around: never a shadow, never a colour", async () => {
    const before = await place(ACCENT);
    const { edit, record } = await place(ACCENT, { backgrounds: mapOf(() => BEIGE) });
    const accent = edit.tracks.overlays[0]!;
    expect(accent.position).toEqual(before.edit.tracks.overlays[0]!.position);
    expect(accent.shadow).toBeUndefined();
    expect(accent.color).toBeUndefined();
    expect(record).toContainEqual({
      item: "accent-1",
      action: "low-contrast",
      rule: "contrast-stay",
      reason: expect.stringMatching(
        /^accent ".+" stays in place: contrast 1\.\d:1 from \d+\.\d\d s to \d+\.\d\d s, no free place nearby reaches 3:1$/,
      ),
    });
  });

  it("leaves the big word in place, plain, on a light background and never moves it", async () => {
    const input = { big_words: [{ word: "w76" }] };
    const before = await place(input);
    const { edit, record } = await place(input, { backgrounds: mapOf(() => BEIGE) });
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    const was = before.edit.tracks.behind!.find((item) => item.kind === "word")!;
    if (word.kind !== "word" || was.kind !== "word") throw new Error("not a word");
    expect(word.position).toEqual(was.position);
    expect(word.shadow).toBeUndefined();
    expect(record).toContainEqual(
      expect.objectContaining({
        item: "big-word-1",
        action: "low-contrast",
        rule: "contrast-stay",
        reason: expect.stringMatching(
          /^the big word ".+" stays in place: .*the big word is never moved$/,
        ),
      }),
    );
    expect(
      record.filter((entry) => entry.item === "big-word-1" && entry.rule === "contrast-spot"),
    ).toEqual([]);
  });

  it("changes nothing on a dark background: the same edit and record as with no map", async () => {
    const input = { ...ACCENT, big_words: [{ word: "w76" }] };
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
    // Its phrase's captions show only as its levels: no place, no note.
    const phrase = new Set(transition!.words);
    const inside = edit.tracks.captions.filter((caption) => phrase.has(caption.words[0]!));
    expect(inside.length).toBeGreaterThan(0);
    for (const caption of inside) {
      expect(caption.position).toBeUndefined();
      expect(caption.shadow).toBeUndefined();
    }
    const outside = edit.tracks.captions.filter((caption) => !inside.includes(caption));
    for (const caption of outside) expect(caption.shadow).toBeUndefined();
    expect(
      record.filter(
        (note) =>
          note.rule === "contrast-stay" && inside.some((caption) => caption.id === note.item),
      ),
    ).toEqual([]);
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

  it("keeps about one transition per 9 s: the sixth to eighth on a 47 s reel are dropped", async () => {
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
    const room = Math.max(
      1,
      Math.round(hand.edit.duration / ISSEBYA_PRESET.pace.transitionEverySeconds),
    );
    expect(room).toBe(5);
    // The same kind repeats.
    expect(edit.tracks.transitions.map((item) => item.id)).toEqual([
      "transition-1",
      "transition-2",
      "transition-3",
      "transition-4",
      "transition-5",
    ]);
    expect(record).toContainEqual({
      item: "transition-8",
      action: "dropped",
      rule: "transition-rate",
      reason:
        'transition 8 (dim) on "life doesn\'t feel" dropped: about one transition per 9 s, this reel has room for 5',
    });
    expect(
      record.filter((note) => note.rule === "transition-rate").map((note) => note.item),
    ).toEqual(["transition-6", "transition-7", "transition-8"]);
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

  it("places a requested mood photo (a loose fit) the same way, keeping its reason", async () => {
    // "add photos behind me" with no photo that shows what is said: the
    // editor picks the best one as `mood`, and the request still makes room.
    const input = {
      ...REQUEST_INPUT,
      photos: REQUEST_INPUT.photos!.map((photo) => ({ ...photo, reason: "mood" as const })),
    };
    const asked = await place(input, { headTrack: LEFT_HEAD, requested: ["photos[0]"] });
    expect(asked.edit.tracks.behind).toEqual([
      expect.objectContaining({ id: "photo-1", photo_id: REQUEST_PHOTO, reason: "mood" }),
    ]);
    expect(asked.unplaced).toEqual([]);
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

  it("hides a requested photo behind the person only as the last step, never below the floor", async () => {
    // A wide face over the middle: no place keeps the photo in view behind
    // the speaker, and in front it would take the captions' only line.
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
    expect(asked.edit.tracks.behind).toEqual([
      expect.objectContaining({ id: "photo-1", layer: "behind" }),
    ]);
    expect(makeRoom(asked.record)).toEqual(["covers-face"]);
    expect(
      asked.checks.filter(
        (check) =>
          check.rule !== "behind-face" && check.rule !== "photo-hidden" && check.rule !== "face",
      ),
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
      reason:
        "photo 1 sits behind you, where you hide more of it than usual: nothing else was free, as asked",
    });
    expect(
      asked.checks.filter(
        (check) =>
          check.rule !== "behind-face" && check.rule !== "photo-hidden" && check.rule !== "face",
      ),
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

describe("the written hook", () => {
  const HOOK = { text: "Gen Z won't work like you did" };
  const { safe } = ISSEBYA_PRESET;
  const { fromSeconds, untilSeconds } = ISSEBYA_PRESET.pace.hook;
  const hookOf = (edit: Edit) => edit.tracks.overlays.find((item) => item.kind === "hook");

  it("shows from 0.2 s to 3 s in the upper part of the frame, off the face, inside the safe zone", async () => {
    const placed = await place({ hook: HOOK });
    const item = hookOf(placed.edit)!;
    expect(item).toMatchObject({ id: "hook", kind: "hook", text: HOOK.text });
    expect(item.words).toBeUndefined();
    expect(item.shadow).toBeUndefined();
    expect(item.color).toBeUndefined();
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds, end: untilSeconds });
    // Wrapped or shrunk to fit, recorded; always above the middle of the safe zone.
    expect(item.position!.y).toBeGreaterThanOrEqual(safe.top);
    expect(item.position!.y).toBeLessThan((safe.top + safe.bottom) / 2);
    expect(placed.record.filter((note) => note.item === "hook").map((note) => note.rule)).toEqual(
      expect.arrayContaining(["hook-wrap"]),
    );
    // Its own class, the accents' entrance.
    expect(placed.html).toContain('class="text hook f-primary"');
    expect(placed.html).toContain(".hook { text-align: center; }");
    expect(placed.checks).toEqual([]);
    // Nobody says it: no caption is left out for it.
    expect(placed.edit.tracks.captions.some((caption) => caption.hidden_by === "hook")).toBe(false);
    expectNoWordTwice(placed.edit, placed.spans);
  });

  it("is the one extra of its window: an accent in it is dropped, one after it shows", async () => {
    const placed = await place({
      hook: HOOK,
      accents: [
        { from: "w2", to: "w3", title: true },
        { from: "w12", to: "w12", title: false },
      ],
    });
    expect(placed.edit.tracks.overlays.map((item) => item.id)).toEqual(["hook", "accent-1"]);
    expect(placed.record).toContainEqual({
      item: "title",
      action: "dropped",
      rule: "one-extra",
      reason: expect.stringContaining(
        'at the same time as the hook "Gen Z won\'t work like you did"',
      ),
    });
    expect(placed.unplaced).toEqual([expect.objectContaining({ ref: "accents[0]", why: "busy" })]);
    // The accent after it takes its lead once the hook has gone.
    expect(placed.spans.get("accent-1")!.start).toBeGreaterThanOrEqual(untilSeconds);
    expect(placed.checks).toEqual([]);
  });

  it("is never cut short: an accent said just before it ends is dropped, not the hook", async () => {
    const placed = await place({ hook: HOOK, accents: [{ from: "w9", to: "w9", title: false }] });
    expect(placed.spans.get("hook")).toMatchObject({ start: fromSeconds, end: untilSeconds });
    expect(placed.edit.tracks.overlays.map((item) => item.id)).toEqual(["hook"]);
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "accent-1", action: "dropped", rule: "one-extra" }),
    );
  });

  it("never lets a transition run during it: one in its window is dropped, a later one kept", async () => {
    const placed = await place({
      hook: HOOK,
      transitions: [
        { kind: "dim", from: "w4", to: "w9", key_from: "w6" },
        { kind: "panel", from: "w26", to: "w33", key_from: "w30" },
      ],
    });
    expect(placed.edit.tracks.transitions.map((item) => item.id)).toEqual(["transition-2"]);
    expect(placed.record).toContainEqual({
      item: "transition-1",
      action: "dropped",
      rule: "hook",
      reason: expect.stringMatching(
        /while the hook shows from 0\.20 s to 3\.00 s; no transition during the hook$/,
      ),
    });
    expect(placed.checks).toEqual([]);
  });

  it("makes room like an owner's request and covers the face only as the last step", async () => {
    const HUGE = steadyHead({ head_top: 100, cx: 540, head_w: 1000 });
    const placed = await place({ hook: HOOK }, { headTrack: HUGE });
    expect(hookOf(placed.edit)).toBeDefined();
    const notes = placed.record.filter((note) => note.item === "hook");
    expect(notes).toContainEqual(
      expect.objectContaining({ action: "covers-face", rule: "make-room" }),
    );
    // Given room on every run, so never "as asked" unless the owner asked.
    expect(placed.record.filter((note) => note.reason.endsWith("as asked"))).toEqual([]);
    expect(placed.checks.filter((check) => check.rule === "text-overlap")).toEqual([]);
    // Captions are never dropped for it.
    const plain = await place({}, { headTrack: HUGE });
    expect(placed.edit.tracks.captions.map((caption) => caption.words)).toEqual(
      plain.edit.tracks.captions.map((caption) => caption.words),
    );
  });

  it("reads back as its text and places the same again; a version without one reads null", async () => {
    const measurer = await nodeMeasurer();
    const placed = await place({ hook: HOOK, accents: [{ from: "w12", to: "w14", title: false }] });
    const choices = choicesOf(placed.edit, transcript, ISSEBYA_PRESET);
    expect(choices.hook).toEqual(HOOK);
    expect(choicesOf(hand.edit, transcript, ISSEBYA_PRESET).hook).toBeNull();
    const again = placeEdit(
      { ...hand.edit, tracks: { ...hand.edit.tracks, ...placed.edit.tracks } },
      choices,
      transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      measurer,
    );
    expect(again.tracks.overlays).toEqual(placed.edit.tracks.overlays);
  });

  it("is dropped, with the reason, only on a reel too short to show it", async () => {
    const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;
    const measurer = await nodeMeasurer();
    const tiny = { ...short.edit, duration: 1.2 };
    const placed = placeEdit(
      tiny,
      { ...NOTHING, hook: HOOK },
      short.transcript,
      short.headTrack,
      ISSEBYA_PRESET,
      measurer,
    );
    expect(placed.tracks.overlays).toEqual([]);
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "hook", action: "dropped", rule: "hook-time" }),
    );
  });
});
