import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  decideAnswerSchemaFor,
  decideCounts,
  decideJsonSchema,
  editFromAnswer,
  hookJsonSchema,
  parseDecideAnswer,
  parseHookAnswer,
  stripHookStop,
  usedFreeField,
} from "./decide.ts";
import { ISSEBYA_PRESET, TRANSITION_KINDS } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { resolveTimeline } from "./timeline.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;

const OTHER = "1f2e3d4c-5b6a-4789-8a7b-6c5d4e3f2a1b";

type Json = Record<string, unknown>;

// Every node of a JSON Schema, with the property name it hangs under.
function walk(
  node: unknown,
  visit: (node: Json, key: string | null) => void,
  key: string | null = null,
) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, key);
    return;
  }
  if (!node || typeof node !== "object") return;
  visit(node as Json, key);
  for (const [name, value] of Object.entries(node)) {
    if (name === "properties" && value && typeof value === "object") {
      for (const [prop, schema] of Object.entries(value)) walk(schema, visit, prop);
    } else {
      walk(value, visit, key);
    }
  }
}

function enumsUnder(schema: unknown, property: string): unknown[][] {
  const found: unknown[][] = [];
  walk(schema, (node, key) => {
    if (key === property && Array.isArray(node.enum)) found.push(node.enum);
  });
  return found;
}

// A valid answer over the fixture clip, in the new vocabulary: one accent
// word and one fixed word; `change` edits a copy.
function answer(change: (answer: Json) => void = () => {}): Json {
  const value: Json = {
    accents: [{ from: "w0005", to: "w0005" }],
    questions: [],
    big_words: [],
    visuals: [],
    transitions: [],
    word_fixes: [{ word: "w0010", text: "Studio" }],
  };
  change(value);
  return value;
}

function parse(json: unknown) {
  return parseDecideAnswer(json, ISSEBYA_PRESET, short.transcript);
}

function reasons(json: unknown) {
  const parsed = parse(json);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reasons.join("\n");
}

describe("decideJsonSchema", () => {
  for (const fixture of [hand, short]) {
    it(`is generated for ${fixture.name}: its word ids, the list kind only, closed objects`, () => {
      const schema = decideJsonSchema(ISSEBYA_PRESET, fixture.transcript);
      const ids = fixture.transcript.words.map((word) => word.id);
      for (const key of ["from", "to", "word"]) {
        const lists = enumsUnder(schema, key);
        expect(lists.length).toBeGreaterThan(0);
        for (const list of lists) expect(list).toEqual(ids);
      }
      // LIST only: `numbered` is the one kind a new answer may pick.
      expect(enumsUnder(schema, "kind")).toEqual([["numbered"]]);
      expect(TRANSITION_KINDS).toEqual(["numbered"]);
      expect(JSON.stringify(schema)).not.toContain('"dim"');
      expect(JSON.stringify(schema)).not.toContain('"card"');
      // No wish anywhere: a new answer has no request to forward.
      expect(JSON.stringify(schema)).not.toContain('"wish"');

      let objects = 0;
      walk(schema, (node) => {
        if (node.type !== "object" || !node.properties) return;
        objects += 1;
        expect(node.additionalProperties).toBe(false);
      });
      expect(objects).toBeGreaterThan(5);
    });

    it(`targets draft-07 for ${fixture.name}, with the same constraints as the 2020-12 output`, () => {
      const schema = decideJsonSchema(ISSEBYA_PRESET, fixture.transcript);
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(JSON.stringify(schema)).not.toContain("2020-12");
      const draft2020: Json = z.toJSONSchema(
        decideAnswerSchemaFor(ISSEBYA_PRESET, fixture.transcript),
        { target: "draft-2020-12", io: "output", reused: "inline" },
      );
      expect({ ...schema, $schema: null }).toEqual({ ...draft2020, $schema: null });
    });
  }

  it("has the components only: ACCENT, QUESTION, BIGWORD, VISUAL, LIST and the word fixes (no hook)", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript);
    expect(Object.keys(schema.properties as Json)).toEqual([
      "accents",
      "questions",
      "big_words",
      "visuals",
      "transitions",
      "word_fixes",
    ]);
    expect(schema.required).toEqual([
      "accents",
      "questions",
      "big_words",
      "visuals",
      "transitions",
      "word_fixes",
    ]);
  });

  it("has meaning only: no time, position, size, font, colour, spot, style or title anywhere", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript);
    const keys = new Set<string>();
    walk(schema, (_node, key) => {
      if (key) keys.add(key);
    });
    for (const banned of [
      "time",
      "start",
      "end",
      "offset",
      "position",
      "x",
      "y",
      "size",
      "font",
      "color",
      "spot",
      "style",
      "tracks",
      "free_field",
      "title",
      "wish",
      "checklist",
      "behind_rules",
      "unexpressed",
    ]) {
      expect(keys.has(banned), banned).toBe(false);
    }
  });

  it("names a visual by its words and a short description: no photo id, no reason", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript) as {
      properties: Record<string, { maxItems?: number; items: { required: string[] } }>;
    };
    expect(schema.properties.visuals!.items.required).toEqual(["from", "to", "description"]);
    const keys = new Set<string>();
    walk(schema, (_node, key) => {
      if (key) keys.add(key);
    });
    expect(keys.has("photo_id")).toBe(false);
    expect(keys.has("reason")).toBe(false);
    // No count cap on any list: the JSON Schema carries no maxItems.
    for (const name of ["accents", "big_words", "visuals", "transitions", "word_fixes"]) {
      expect(schema.properties[name]!.maxItems, name).toBeUndefined();
    }
  });
});

describe("the hook", () => {
  const hookReasons = (json: unknown) => {
    const parsed = parseHookAnswer(json, ISSEBYA_PRESET);
    if (parsed.ok) throw new Error("expected a refusal");
    return parsed.reasons.join("\n");
  };
  const hook = (text: string) => ({ text });

  it("is its own answer: one text, required, never null", () => {
    expect(parseHookAnswer(hook("Gen Z won't work like you did"), ISSEBYA_PRESET)).toEqual({
      ok: true,
      text: "Gen Z won't work like you did",
    });
    const schema = hookJsonSchema(ISSEBYA_PRESET) as {
      properties: Json;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(["text"]);
    expect(schema.required).toEqual(["text"]);
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('"type":"null"');
    expect(hookReasons({})).toContain("text:");
    expect(hookReasons(null)).not.toBe("");
  });

  it("is not a component: the components answer refuses a hook", () => {
    expect(reasons(answer((a) => (a.hook = { text: "Rethink work" })))).toContain(
      'Unrecognized key: "hook"',
    );
    expect(reasons(answer((a) => (a.hook = null)))).toContain('Unrecognized key: "hook"');
  });

  it("refuses more than the preset's words or characters, with the reason for the retry", () => {
    const { maxWords, maxCharacters } = ISSEBYA_PRESET.pace.hook;
    expect([maxWords, maxCharacters]).toEqual([7, 45]);
    expect(hookReasons(hook("one two three four five six seven eight"))).toContain(
      "text: a hook has at most 7 words",
    );
    expect(hookReasons(hook("x".repeat(46)))).toContain("text: a hook has at most 45 characters");
    expect(
      parseHookAnswer(hook("one two three four five six seven"), ISSEBYA_PRESET),
    ).toMatchObject({
      ok: true,
    });
  });

  it("is one line of plain text: no line break, no tag, not empty", () => {
    expect(hookReasons(hook("first\nsecond"))).toContain("a hook is one line of plain text");
    expect(hookReasons(hook("<b>bold</b>"))).toContain("a hook is one line of plain text");
    expect(hookReasons(hook("!!!"))).toContain("a hook needs words");
    expect(hookReasons(hook(""))).toContain("text:");
  });

  it("never ends with a full stop: final dots and ellipses are taken off, ? and ! stay", () => {
    expect(stripHookStop("Gen Z won't work like you did.")).toBe("Gen Z won't work like you did");
    expect(stripHookStop("Gen Z won't work like you did...")).toBe("Gen Z won't work like you did");
    expect(stripHookStop("Gen Z won't work like you did… ")).toBe("Gen Z won't work like you did");
    expect(stripHookStop("Would you work like this?")).toBe("Would you work like this?");
    expect(stripHookStop("Stop working like this!")).toBe("Stop working like this!");
    expect(stripHookStop("Mr. Smith knows")).toBe("Mr. Smith knows");
    expect(stripHookStop("Mr. Smith knows.")).toBe("Mr. Smith knows");
  });

  it("is saved without its final full stop, and nothing but dots is refused", () => {
    expect(parseHookAnswer(hook("Gen Z won't work like you did."), ISSEBYA_PRESET)).toEqual({
      ok: true,
      text: "Gen Z won't work like you did",
    });
    expect(parseHookAnswer(hook("Would you work like this?"), ISSEBYA_PRESET)).toEqual({
      ok: true,
      text: "Would you work like this?",
    });
    expect(hookReasons(hook("..."))).toContain("a hook needs words");
    expect(hookReasons(hook("…"))).toContain("a hook needs words");
  });

  it("has no wish, time or place: only its text", () => {
    expect(hookReasons({ text: "Rethink work", wish: "top" })).toContain(
      'Unrecognized key: "wish"',
    );
    expect(hookReasons({ text: "Rethink work", start: 0 })).toContain('Unrecognized key: "start"');
  });

  it("is placed by the engine beside the components: from 0.2 s, an accent in its window kept beside it", async () => {
    const parsed = parse(answer());
    if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
    const written = parseHookAnswer(hook("A short test for the real studio"), ISSEBYA_PRESET);
    if (!written.ok) throw new Error(written.reasons.join("; "));
    const placed = editFromAnswer(
      short.edit,
      { ...parsed.answer, hook: { text: written.text } },
      ISSEBYA_PRESET,
      short.transcript,
      short.headTrack,
      await nodeMeasurer(),
    );
    if (!placed.ok) throw new Error(placed.reasons.join("; "));
    const item = placed.edit.tracks.overlays.find((overlay) => overlay.kind === "hook")!;
    expect(item).toMatchObject({ id: "hook", text: "A short test for the real studio" });
    expect(item.words).toBeUndefined();
    // On the 2.7 s clip the accent said in the hook's window cuts the hook where
    // it starts; the accent shows its own words, noted.
    expect(placed.edit.tracks.overlays.map((overlay) => overlay.id)).toEqual(["hook", "accent-1"]);
    const hookSpan = resolveTimeline(placed.edit, short.transcript).get("hook")!;
    const accentSpan = resolveTimeline(placed.edit, short.transcript).get("accent-1")!;
    expect(hookSpan.end).toBeCloseTo(accentSpan.start, 3);
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "hook", action: "retimed", rule: "text-one-at-a-time" }),
    );
  });
});

describe("parseDecideAnswer", () => {
  it("accepts a valid answer", () => {
    expect(parse(answer())).toMatchObject({ ok: true });
  });

  it("refuses an answer missing a field", () => {
    const missing = answer((a) => {
      delete a.accents;
    });
    expect(reasons(missing)).toMatch(/^accents: /m);
    const noBigWords = answer((a) => {
      delete a.big_words;
    });
    expect(reasons(noBigWords)).toMatch(/^big_words: /m);
  });

  it("refuses a word id not in the transcript", () => {
    const other = answer((a) => {
      (a.accents as Json[])[0]!.from = "w9999";
    });
    expect(reasons(other)).toMatch(/^accents\.0\.from: /m);
    const fix = answer((a) => {
      a.word_fixes = [{ word: "w0", text: "x" }];
    });
    expect(reasons(fix)).toMatch(/^word_fixes\.0\.word: /m);
  });

  it("refuses times, positions and sizes: the answer is closed", () => {
    const timed = answer((a) => {
      (a.accents as Json[])[0]!.start = { time: 1 };
    });
    expect(reasons(timed)).toMatch(/accents\.0: .*start/);
    const sized = answer((a) => {
      (a.accents as Json[])[0]!.size = 80;
    });
    expect(parse(sized).ok).toBe(false);
  });

  it("refuses a phrase that ends before it starts", () => {
    const backwards = answer((a) => {
      a.accents = [{ from: "w0008", to: "w0006" }];
    });
    expect(reasons(backwards)).toContain("accents.0.to: ends on w0006, before it starts on w0008");
  });

  it("refuses a title: the written hook is the title now", () => {
    const titled = answer((a) => {
      (a.accents as Json[])[0]!.title = true;
    });
    expect(reasons(titled)).toMatch(/accents\.0: .*title/);
    expect(parse(titled).ok).toBe(false);
  });

  it("refuses a transition of any kind but numbered: no dim, panel or card", () => {
    for (const kind of ["dim", "panel", "card"]) {
      const old = answer((a) => {
        a.transitions = [{ kind, from: "w0006", to: "w0008", key_from: "w0007" }];
      });
      expect(reasons(old), kind).toMatch(/^transitions\.0\.kind: /m);
    }
    const numbered = answer((a) => {
      a.transitions = [{ kind: "numbered", from: "w0006", to: "w0008", key_from: "w0007" }];
    });
    expect(parse(numbered).ok).toBe(true);
  });

  it("refuses a transition without key_from, or with its key phrase outside its phrase", () => {
    const withList = (item: Json) => answer((a) => (a.transitions = [item]));
    const base = { kind: "numbered", from: "w0006", to: "w0008", key_from: "w0007" };
    expect(reasons(withList({ ...base, key_from: undefined }))).toMatch(
      /^transitions\.0\.key_from: /m,
    );
    expect(reasons(withList({ ...base, key_from: "w0009" }))).toContain(
      "transitions.0.key_from: key phrase starts on w0009, outside w0006 to w0008",
    );
    expect(reasons(withList({ ...base, key_from: "w0005" }))).toContain(
      "transitions.0.key_from: key phrase starts on w0005, outside w0006 to w0008",
    );
    expect(parse(withList({ ...base, key_from: "w0006" })).ok).toBe(true);
  });

  it("refuses a wish: a new answer forwards none", () => {
    const wished = answer((a) => {
      (a.accents as Json[])[0]!.wish = "big";
    });
    expect(reasons(wished)).toMatch(/accents\.0: .*wish/);
    const slow = answer((a) => {
      a.transitions = [
        { kind: "numbered", from: "w0006", to: "w0008", key_from: "w0007", wish: "slow" },
      ];
    });
    expect(reasons(slow)).toMatch(/transitions\.0: .*wish/);
    const bigWish = answer((a) => {
      a.big_words = [{ from: "w0005", to: "w0005", wish: "behind" }];
    });
    expect(reasons(bigWish)).toMatch(/big_words\.0: .*wish/);
    const visual = answer((a) => {
      a.visuals = [{ from: "w0001", to: "w0010", description: "a desk", wish: "left" }];
    });
    expect(parse(visual).ok).toBe(false);
  });

  it("refuses a checklist, behind rules and unexpressed: a new answer has no request", () => {
    expect(reasons(answer((a) => (a.checklist = [])))).toContain('Unrecognized key: "checklist"');
    expect(
      reasons(answer((a) => (a.behind_rules = { photos: "keep", big_word: "keep" }))),
    ).toContain('Unrecognized key: "behind_rules"');
    expect(reasons(answer((a) => (a.unexpressed = [])))).toContain(
      'Unrecognized key: "unexpressed"',
    );
    const asked = answer((a) => {
      a.checklist = [{ ask: "no hook", wants: "no hook", fulfilled_by: ["hook"] }];
    });
    expect(parse(asked).ok).toBe(false);
  });

  it("refuses a word fixed twice", () => {
    const twice = answer((a) => {
      a.word_fixes = [
        { word: "w0010", text: "Studio" },
        { word: "w0010", text: "Stadium" },
      ];
    });
    expect(reasons(twice)).toContain("word_fixes: w0010 is fixed twice");
  });

  it("refuses a change title or summary: they are written after layout", () => {
    expect(parse(answer((a) => (a.change_title = "Photo added"))).ok).toBe(false);
    expect(parse(answer((a) => (a.change_summary = "A photo shows."))).ok).toBe(false);
  });
});

describe("the visual in the decide answer", () => {
  const visual = { from: "w0001", to: "w0010", description: "a messy desk at night" };
  const withVisuals = (visuals: Json[]) =>
    answer((a) => {
      a.visuals = visuals;
    });

  it("takes a visual over its words with a short description", () => {
    expect(parse(withVisuals([visual])).ok).toBe(true);
  });

  it("refuses a photo id or a reason on a visual: a visual names no picture", () => {
    expect(parse(withVisuals([{ ...visual, photo_id: OTHER }])).ok).toBe(false);
    expect(parse(withVisuals([{ ...visual, reason: "mood" }])).ok).toBe(false);
  });

  it("refuses a description over its word or character limit, or with no words", () => {
    const eight = "one two three four five six seven eight";
    expect(parse(withVisuals([{ ...visual, description: eight }])).ok).toBe(true);
    const nine = `${eight} nine`;
    expect(reasons(withVisuals([{ ...visual, description: nine }]))).toMatch(/at most 8 words/);
    expect(parse(withVisuals([{ ...visual, description: "a".repeat(81) }])).ok).toBe(false);
    expect(parse(withVisuals([{ ...visual, description: "" }])).ok).toBe(false);
    expect(parse(withVisuals([{ ...visual, description: "!!!" }])).ok).toBe(false);
  });

  it("takes as many visuals and big words as the editor chooses, the same word again too", () => {
    const many = answer((a) => {
      a.visuals = [visual, { ...visual, from: "w0006", to: "w0010" }, visual];
      a.big_words = [
        { from: "w0005", to: "w0005" },
        { from: "w0009", to: "w0009" },
        { from: "w0005", to: "w0005" },
      ];
    });
    expect(parse(many).ok).toBe(true);
  });

  it("takes a big word of one or two consecutive words, and refuses a span of three or one ending first", () => {
    expect(parse(answer((a) => (a.big_words = [{ from: "w0005", to: "w0006" }]))).ok).toBe(true);
    expect(reasons(answer((a) => (a.big_words = [{ from: "w0006", to: "w0005" }])))).toMatch(
      /^big_words\.0\.to: ends on w0005, before it starts on w0006$/m,
    );
    expect(reasons(answer((a) => (a.big_words = [{ from: "w0005", to: "w0007" }])))).toMatch(
      /^big_words\.0\.to: w0005 to w0007 spans 3 words; a big word is one or two consecutive words$/m,
    );
  });

  it("checks each word of a two-word big word as one plain word of at most 24 letters", () => {
    const long = structuredClone(short.transcript);
    long.words.find((word) => word.id === "w0006")!.text = "extraordinarilyunbelievablylongword";
    const json = answer((a) => (a.big_words = [{ from: "w0005", to: "w0006" }]));
    const result = parseDecideAnswer(json, ISSEBYA_PRESET, long);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join("\n")).toMatch(
        /^big_words\.0\.to: w0006 \("extraordinarilyunbelievablylongword"\) is not one plain word of at most 24 letters$/m,
      );
    }
  });

  it("has no count cap: 100 picks over a 162-word clip and 80 word fixes on distinct words", () => {
    const ids = hand.transcript.words.map((word) => word.id);
    const span = (start: number, count: number) => ids.slice(start, start + count);
    const json = {
      accents: span(0, 25).map((id) => ({ from: id, to: id })),
      questions: [],
      big_words: span(25, 25).map((id) => ({ from: id, to: id })),
      visuals: span(50, 25).map((id) => ({ from: id, to: id, description: "a messy desk" })),
      transitions: span(75, 25).map((id) => ({ kind: "numbered", from: id, to: id, key_from: id })),
      word_fixes: ids.slice(0, 80).map((id) => ({ word: id, text: "Studio" })),
    };
    const parsed = parseDecideAnswer(json, ISSEBYA_PRESET, hand.transcript);
    expect(parsed.ok ? "ok" : parsed.reasons.join("\n")).toBe("ok");
  });
});

describe("QUESTION in the components answer", () => {
  it("takes as many questions as the editor chooses, the same phrase again too", () => {
    const many = answer((a) => {
      a.questions = [
        { from: "w0005", to: "w0005" },
        { from: "w0009", to: "w0010" },
        { from: "w0005", to: "w0005" },
      ];
    });
    expect(parse(many).ok).toBe(true);
    expect(parse(many)).toMatchObject({ ok: true, answer: { questions: many.questions } });
  });

  it("refuses a question that ends before it starts, with the path questions.N.to", () => {
    expect(reasons(answer((a) => (a.questions = [{ from: "w0006", to: "w0005" }])))).toMatch(
      /^questions\.0\.to: ends on w0005, before it starts on w0006$/m,
    );
  });

  it("needs the questions field: none is an empty list", () => {
    const missing = answer((a) => {
      delete a.questions;
    });
    expect(reasons(missing)).toMatch(/^questions: /m);
    expect(parse(answer((a) => (a.questions = []))).ok).toBe(true);
  });
});

describe("editFromAnswer", () => {
  const place = async (json: Json, current = short.edit) => {
    const parsed = parse(json);
    if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
    return editFromAnswer(
      current,
      parsed.answer,
      ISSEBYA_PRESET,
      short.transcript,
      [],
      await nodeMeasurer(),
    );
  };

  it("keeps the current version's inputs, duration, footage and sounds", async () => {
    const made = await place(answer());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.edit.inputs).toEqual(short.edit.inputs);
    expect(made.edit.duration).toBe(short.edit.duration);
    expect(made.edit.tracks.footage).toEqual(short.edit.tracks.footage);
    expect(made.edit.tracks.sounds).toEqual(short.edit.tracks.sounds);
  });

  it("drops the current masks", async () => {
    const current = structuredClone(short.edit);
    current.inputs.masks = [
      { step: "cutout", fingerprint: "f".repeat(64), file: "mask.mp4", start: 0, end: 2 },
    ];
    const made = await place(answer(), current);
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.edit.inputs.masks).toBeUndefined();
  });

  it("shows a big word said just before the reel ends, beside the visual, both kept", async () => {
    const made = await place(
      answer((a) => {
        a.accents = [];
        a.visuals = [{ from: "w0001", to: "w0010", description: "a messy desk at night" }];
        // Said 0.64 s before the reel ends.
        a.big_words = [{ from: "w0010", to: "w0010" }];
      }),
    );
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.edit.tracks.behind?.map((item) => item.id)).toEqual(["visual-1", "big-word-1"]);
    // The placed visual keeps the answer's description.
    expect(made.edit.tracks.behind?.[0]).toMatchObject({
      kind: "visual",
      description: "a messy desk at night",
    });
    // Shown at its own words' times: no drop, no move, no note.
    expect(made.record.filter((note) => note.item === "big-word-1")).toEqual([]);
  });
});

describe("decideCounts and usedFreeField", () => {
  it("counts accents, transitions, the hook and fixed words", () => {
    const tracks = structuredClone(short.edit.tracks);
    tracks.captions[9]!.text = "Studio";
    // Same as its default text: not a fix.
    tracks.captions[0]!.text = "this";
    tracks.overlays.push(
      {
        id: "accent-test",
        kind: "accent",
        start: { word: "w0005" },
        end: { word: "w0005", edge: "end" },
        words: ["w0005"],
      },
      // The hook is no accent.
      {
        id: "hook",
        kind: "hook",
        start: { reel: "start" },
        end: { word: "w0004", edge: "end" },
        text: "A short test",
      },
    );
    tracks.transitions.push({
      id: "list-a",
      type: "numbered",
      start: { word: "w0006" },
      end: { word: "w0008", edge: "end" },
      words: ["w0006", "w0007", "w0008"],
    });
    // A question is counted as a question, not an accent.
    tracks.overlays.push({
      id: "question-1",
      kind: "accent",
      start: { word: "w0003" },
      end: { word: "w0003", edge: "end" },
      words: ["w0003"],
    });
    const edit = { ...short.edit, tracks };
    expect(decideCounts(edit, short.transcript, ISSEBYA_PRESET)).toEqual({
      accents: 1,
      questions: 1,
      transitions: 1,
      hook: true,
      wordsFixed: 1,
      behindVisuals: 0,
      behindWords: 0,
    });
    expect(usedFreeField(edit)).toBe(false);
    tracks.overlays[1]!.style = { "letter-spacing": "2px" };
    expect(usedFreeField(edit)).toBe(true);
  });
});
