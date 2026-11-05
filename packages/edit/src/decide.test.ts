import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type DecideRules,
  NO_RULES,
  applyBehindRules,
  decideAnswerSchemaFor,
  decideCounts,
  decideJsonSchema,
  editFromAnswer,
  parseDecideAnswer,
  stripHookStop,
  usedFreeField,
} from "./decide.ts";
import { WISHES } from "./engine-input.ts";
import { ISSEBYA_PRESET, TRANSITION_KINDS } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;

const PHOTO = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";
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

// A valid answer over the fixture clip: a title, one accent, one dim
// transition, one fixed word; `change` edits a copy.
function answer(change: (answer: Json) => void = () => {}): Json {
  const value: Json = {
    accents: [
      { from: "w0001", to: "w0004", title: true },
      { from: "w0005", to: "w0005", title: false },
    ],
    big_words: [],
    photos: [],
    transitions: [{ kind: "dim", from: "w0006", to: "w0008", key_from: "w0007" }],
    word_fixes: [{ word: "w0010", text: "Studio" }],
    hook: null,
    checklist: [],
    behind_rules: { photos: "keep", big_word: "keep" },
    unexpressed: [],
  };
  change(value);
  return value;
}

const REQUEST: DecideRules = { requested: true, forbid: { photos: false, bigWord: false } };

function parse(json: unknown, photoIds: readonly string[] = [], rules: DecideRules = NO_RULES) {
  return parseDecideAnswer(json, ISSEBYA_PRESET, short.transcript, photoIds, rules);
}

function reasons(json: unknown, photoIds: readonly string[] = [], rules: DecideRules = NO_RULES) {
  const parsed = parse(json, photoIds, rules);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reasons.join("\n");
}

describe("decideJsonSchema", () => {
  for (const fixture of [hand, short]) {
    it(`is generated for ${fixture.name}: its word ids, the transition kinds, the wishes, closed objects`, () => {
      const schema = decideJsonSchema(ISSEBYA_PRESET, fixture.transcript);
      const ids = fixture.transcript.words.map((word) => word.id);
      for (const key of ["from", "to", "word"]) {
        const lists = enumsUnder(schema, key);
        expect(lists.length).toBeGreaterThan(0);
        for (const list of lists) expect(list).toEqual(ids);
      }
      // The library only: `card` is never offered.
      expect(enumsUnder(schema, "kind")).toEqual([[...TRANSITION_KINDS]]);
      expect(JSON.stringify(schema)).not.toContain('"card"');
      const wishes = enumsUnder(schema, "wish");
      expect(wishes).toHaveLength(4);
      for (const list of wishes) expect(list).toEqual([...WISHES]);

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

  it("has meaning only: no time, position, size, font, colour, spot or style anywhere", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript, [PHOTO], REQUEST);
    expect(Object.keys(schema.properties as Json)).toEqual([
      "accents",
      "big_words",
      "photos",
      "transitions",
      "word_fixes",
      "hook",
      "checklist",
      "behind_rules",
      "unexpressed",
    ]);
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
    ]) {
      expect(keys.has(banned), banned).toBe(false);
    }
  });

  it("names the library photos, with no per-reel count for photos or big words", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript, [PHOTO]) as {
      properties: { photos: { maxItems: number }; big_words: { maxItems: number } };
    };
    expect(enumsUnder(schema, "photo_id")).toEqual([[PHOTO]]);
    // Every photo says why it is there.
    expect(enumsUnder(schema, "reason")).toEqual([["match", "mood"]]);
    const item = (schema.properties.photos as unknown as { items: { required: string[] } }).items;
    expect(item.required).toContain("reason");
    // Only a bound on the answer's size, like the accents'.
    expect(schema.properties.photos.maxItems).toBe(12);
    expect(schema.properties.big_words.maxItems).toBe(12);
  });
});

describe("the hook", () => {
  const hook = (text: string) => answer((a) => (a.hook = { text }));

  it("is a required field: a line of text, or null for none", () => {
    expect(parse(hook("Gen Z won't work like you did"))).toMatchObject({ ok: true });
    expect(parse(answer())).toMatchObject({ ok: true });
    const missing = answer((a) => delete a.hook);
    expect(reasons(missing)).toContain("hook:");
    const schema = decideJsonSchema(ISSEBYA_PRESET, short.transcript) as {
      properties: { hook: { anyOf: Json[] } };
    };
    expect(schema.properties.hook.anyOf).toContainEqual({ type: "null" });
  });

  it("refuses more than the preset's words or characters, with the reason for the retry", () => {
    const { maxWords, maxCharacters } = ISSEBYA_PRESET.pace.hook;
    expect([maxWords, maxCharacters]).toEqual([7, 45]);
    expect(reasons(hook("one two three four five six seven eight"))).toContain(
      "hook.text: a hook has at most 7 words",
    );
    expect(reasons(hook("x".repeat(46)))).toContain("hook.text: a hook has at most 45 characters");
    expect(parse(hook("one two three four five six seven"))).toMatchObject({ ok: true });
  });

  it("is one line of plain text: no line break, no tag, not empty", () => {
    expect(reasons(hook("first\nsecond"))).toContain("a hook is one line of plain text");
    expect(reasons(hook("<b>bold</b>"))).toContain("a hook is one line of plain text");
    expect(reasons(hook("!!!"))).toContain("a hook needs words");
    expect(reasons(hook(""))).toContain("hook.text:");
  });

  it("never ends with a full stop: final dots and ellipses are taken off, ? and ! stay", () => {
    expect(stripHookStop("Gen Z won't work like you did.")).toBe("Gen Z won't work like you did");
    expect(stripHookStop("Gen Z won't work like you did...")).toBe("Gen Z won't work like you did");
    expect(stripHookStop("Gen Z won't work like you did\u2026 ")).toBe(
      "Gen Z won't work like you did",
    );
    expect(stripHookStop("Would you work like this?")).toBe("Would you work like this?");
    expect(stripHookStop("Stop working like this!")).toBe("Stop working like this!");
    expect(stripHookStop("Mr. Smith knows")).toBe("Mr. Smith knows");
    expect(stripHookStop("Mr. Smith knows.")).toBe("Mr. Smith knows");
  });

  it("is saved without its final full stop, and nothing but dots is refused", () => {
    expect(parse(hook("Gen Z won't work like you did."))).toMatchObject({
      ok: true,
      answer: { hook: { text: "Gen Z won't work like you did" } },
    });
    expect(parse(hook("Would you work like this?"))).toMatchObject({
      ok: true,
      answer: { hook: { text: "Would you work like this?" } },
    });
    expect(reasons(hook("..."))).toContain("a hook needs words");
    expect(reasons(hook("\u2026"))).toContain("a hook needs words");
  });

  it("has no wish, time or place: only its text", () => {
    expect(reasons(answer((a) => (a.hook = { text: "Rethink work", wish: "top" })))).toContain(
      "hook:",
    );
    expect(reasons(answer((a) => (a.hook = { text: "Rethink work", start: 0 })))).toContain(
      "hook:",
    );
  });

  it("may be linked from the checklist, set or taken out", () => {
    const linked = (value: Json | null) =>
      answer((a) => {
        a.hook = value;
        a.checklist = [{ ask: "no hook", wants: "no hook", fulfilled_by: ["hook"] }];
      });
    expect(parse(linked(null), [], REQUEST)).toMatchObject({ ok: true });
    expect(parse(linked({ text: "Work less" }), [], REQUEST)).toMatchObject({ ok: true });
  });

  it("is placed by the engine: from 0.2 s, the one extra of its window", async () => {
    const parsed = parse(hook("A short test for the real studio"));
    if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
    const placed = editFromAnswer(
      short.edit,
      parsed.answer,
      ISSEBYA_PRESET,
      short.transcript,
      short.headTrack,
      await nodeMeasurer(),
    );
    if (!placed.ok) throw new Error(placed.reasons.join("; "));
    const item = placed.edit.tracks.overlays.find((overlay) => overlay.kind === "hook")!;
    expect(item).toMatchObject({ id: "hook", text: "A short test for the real studio" });
    expect(item.words).toBeUndefined();
    // On the 2.7 s clip it holds the screen: the title, the accent and the dim
    // wait for nothing and are dropped.
    expect(placed.edit.tracks.overlays.map((overlay) => overlay.id)).toEqual(["hook"]);
    expect(placed.edit.tracks.transitions).toEqual([]);
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "transition-1", action: "dropped", rule: "hook" }),
    );
    expect(placed.record).toContainEqual(
      expect.objectContaining({ item: "title", action: "dropped", rule: "one-extra" }),
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

  it("refuses a wish not on the list", () => {
    const loose = answer((a) => {
      (a.accents as Json[])[1]!.wish = "upper-left";
    });
    expect(reasons(loose, [], REQUEST)).toMatch(/^accents\.1\.wish: /m);
    const listed = answer((a) => {
      (a.accents as Json[])[1]!.wish = "big";
    });
    expect(parse(listed, [], REQUEST).ok).toBe(true);
  });

  it("refuses a wish without a request: Claude never invents one", () => {
    const wished = answer((a) => {
      (a.accents as Json[])[1]!.wish = "big";
      a.big_words = [{ word: "w0001" }, { word: "w0002", wish: "behind" }];
    });
    const text = reasons(wished);
    expect(text).toContain(
      "accents.1.wish: a wish only forwards the owner's request; there is none, leave it out",
    );
    expect(text).toMatch(/^big_words\.1\.wish: /m);
  });

  it("refuses a word id not in the transcript", () => {
    const other = answer((a) => {
      (a.accents as Json[])[1]!.from = "w9999";
    });
    expect(reasons(other)).toMatch(/^accents\.1\.from: /m);
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
      (a.transitions as Json[])[0]!.size = 80;
    });
    expect(parse(sized).ok).toBe(false);
  });

  it("refuses a phrase that ends before it starts, and a second title", () => {
    const backwards = answer((a) => {
      a.transitions = [{ kind: "dim", from: "w0008", to: "w0006", key_from: "w0008" }];
    });
    expect(reasons(backwards)).toContain(
      "transitions.0.to: ends on w0006, before it starts on w0008",
    );
    const two = answer((a) => {
      (a.accents as Json[])[1]!.title = true;
    });
    expect(reasons(two)).toContain("accents: only one accent is the title");
  });

  it("refuses a card: the library is dim, panel and numbered", () => {
    const card = answer((a) => {
      (a.transitions as Json[])[0]!.kind = "card";
    });
    expect(reasons(card)).toMatch(/^transitions\.0\.kind: /m);
    const numbered = answer((a) => {
      (a.transitions as Json[])[0]!.kind = "numbered";
    });
    expect(parse(numbered).ok).toBe(true);
  });

  it("refuses a transition without key_from, or with its key phrase outside its phrase", () => {
    const missing = answer((a) => {
      delete (a.transitions as Json[])[0]!.key_from;
    });
    expect(reasons(missing)).toMatch(/^transitions\.0\.key_from: /m);
    const after = answer((a) => {
      (a.transitions as Json[])[0]!.key_from = "w0009";
    });
    expect(reasons(after)).toContain(
      "transitions.0.key_from: key phrase starts on w0009, outside w0006 to w0008",
    );
    const before = answer((a) => {
      (a.transitions as Json[])[0]!.key_from = "w0005";
    });
    expect(reasons(before)).toContain(
      "transitions.0.key_from: key phrase starts on w0005, outside w0006 to w0008",
    );
    const whole = answer((a) => {
      (a.transitions as Json[])[0]!.key_from = "w0006";
    });
    expect(parse(whole).ok).toBe(true);
  });

  it("takes slow and long only on a request", () => {
    for (const wish of ["slow", "long"]) {
      const asked = answer((a) => {
        (a.transitions as Json[])[0]!.wish = wish;
      });
      expect(reasons(asked)).toContain(
        "transitions.0.wish: a wish only forwards the owner's request; there is none, leave it out",
      );
      expect(parse(asked, [], REQUEST).ok).toBe(true);
    }
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

describe("the request checklist", () => {
  const withAsk = (fulfilledBy: string[]) =>
    answer((a) => {
      a.photos = [{ photo_id: PHOTO, from: "w0001", to: "w0010", reason: "match", wish: "left" }];
      a.checklist = [
        { ask: "photos behind", wants: "1 to 2, free choice", fulfilled_by: fulfilledBy },
      ];
    });

  it("is empty on the first run", () => {
    expect(reasons(withAsk(["photos[0]"]), [PHOTO])).toContain(
      "checklist: the checklist stays empty without a request",
    );
    const schema = decideJsonSchema(ISSEBYA_PRESET, short.transcript) as {
      properties: { checklist: { maxItems: number } };
    };
    expect(schema.properties.checklist.maxItems).toBe(0);
  });

  it("links each ask to answer items on a request", () => {
    expect(parse(withAsk(["photos[0]", "behind_rules"]), [PHOTO], REQUEST).ok).toBe(true);
    expect(parse(withAsk([]), [PHOTO], REQUEST).ok).toBe(true);
  });

  it("carries an optional why_not in plain words for an ask nothing can do", () => {
    const impossible = answer((a) => {
      a.checklist = [
        {
          ask: "add images behind me",
          wants: "1 photo",
          fulfilled_by: [],
          why_not: "Your photo library is empty: upload photos first",
        },
      ];
    });
    expect(parse(impossible, [], REQUEST).ok).toBe(true);
    const tooLong = structuredClone(impossible);
    (tooLong.checklist as Json[])[0]!.why_not = "x".repeat(301);
    expect(reasons(tooLong, [], REQUEST)).toMatch(/^checklist\.0\.why_not: /m);
    // Still a draft-07 schema with every object closed.
    const schema = decideJsonSchema(ISSEBYA_PRESET, short.transcript, [], REQUEST) as {
      $schema: string;
      properties: {
        checklist: {
          items: { additionalProperties: boolean; properties: Json; required: string[] };
        };
      };
    };
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    const entry = schema.properties.checklist.items;
    expect(entry.additionalProperties).toBe(false);
    expect(Object.keys(entry.properties)).toContain("why_not");
    expect(entry.required).not.toContain("why_not");
  });

  it("refuses a link to an item the answer does not have, or not an item at all", () => {
    expect(reasons(withAsk(["photos[1]"]), [PHOTO], REQUEST)).toContain(
      "checklist.0.fulfilled_by: photos[1] is not in the answer",
    );
    expect(reasons(withAsk(["big_words[0]"]), [PHOTO], REQUEST)).toContain(
      "checklist.0.fulfilled_by: big_words[0] is not in the answer",
    );
    // The old single reference is no item now.
    expect(reasons(withAsk(["big_word"]), [PHOTO], REQUEST)).toMatch(
      /^checklist\.0\.fulfilled_by\.0: /m,
    );
    expect(reasons(withAsk(["the photo"]), [PHOTO], REQUEST)).toMatch(
      /^checklist\.0\.fulfilled_by\.0: /m,
    );
  });
});

describe("the behind limits and rules in the decide answer", () => {
  const photo = { photo_id: PHOTO, from: "w0001", to: "w0010", reason: "match" };
  const withPhotos = (photos: Json[], rules?: Json) =>
    answer((a) => {
      a.photos = photos;
      if (rules) a.behind_rules = rules;
    });
  const stored = (photos: boolean, bigWord = false, requested = false): DecideRules => ({
    requested,
    forbid: { photos, bigWord },
  });

  it("refuses a photo outside the library, and every photo with an empty library", () => {
    expect(parse(withPhotos([photo]), [PHOTO]).ok).toBe(true);
    expect(parse(withPhotos([{ ...photo, photo_id: OTHER }]), [PHOTO]).ok).toBe(false);
    expect(parse(withPhotos([photo])).ok).toBe(false);
  });

  it("needs each photo's reason, match or mood, on a new answer", () => {
    const bare: Json = { ...photo };
    delete bare.reason;
    expect(reasons(withPhotos([bare]), [PHOTO])).toMatch(/^photos\.0\.reason: /m);
    expect(parse(withPhotos([{ ...photo, reason: "loose" }]), [PHOTO]).ok).toBe(false);
    expect(parse(withPhotos([{ ...photo, reason: "mood" }]), [PHOTO]).ok).toBe(true);
  });

  it("takes as many photos and big words as the editor chooses, the same word again too", () => {
    const many = answer((a) => {
      a.photos = [photo, { ...photo, from: "w0006", to: "w0010" }, photo];
      a.big_words = [{ word: "w0005" }, { word: "w0009" }, { word: "w0005" }];
    });
    expect(parse(many, [PHOTO]).ok).toBe(true);
  });

  it("refuses a photo under a stored forbid with keep, accepts it with allow on a request", () => {
    expect(reasons(withPhotos([photo]), [PHOTO], stored(true, false, true))).toContain(
      "photos: photos are switched off for this reel by the owner",
    );
    const allowed = withPhotos([photo], { photos: "allow", big_word: "keep" });
    expect(parse(allowed, [PHOTO], stored(true, false, true)).ok).toBe(true);
  });

  it("refuses forbid and allow without a request, and a photo in the answer that forbids photos", () => {
    const forbid = withPhotos([], { photos: "forbid", big_word: "keep" });
    expect(parse(forbid, [PHOTO]).ok).toBe(false);
    expect(parse(forbid, [PHOTO], REQUEST).ok).toBe(true);
    const both = withPhotos([photo], { photos: "forbid", big_word: "keep" });
    expect(parse(both, [PHOTO], REQUEST).ok).toBe(false);
  });

  it("refuses big words while they are forbidden", () => {
    const big = answer((a) => (a.big_words = [{ word: "w0005" }]));
    expect(parse(big).ok).toBe(true);
    expect(reasons(big, [], stored(false, true))).toContain(
      "big_words: big words are switched off for this reel by the owner",
    );
  });

  it("applies the rules to the stored flags", () => {
    const flags = { photos: true, bigWord: false };
    expect(applyBehindRules(flags, { photos: "keep", big_word: "keep" })).toEqual(flags);
    expect(applyBehindRules(flags, { photos: "allow", big_word: "forbid" })).toEqual({
      photos: false,
      bigWord: true,
    });
  });
});

describe("editFromAnswer", () => {
  const place = async (json: Json, current = short.edit) => {
    const parsed = parse(json, [PHOTO], REQUEST);
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

  it("drops the current masks and photos", async () => {
    const current = structuredClone(short.edit);
    current.inputs.masks = [
      { step: "cutout", fingerprint: "f".repeat(64), file: "mask.mp4", start: 0, end: 2 },
    ];
    current.inputs.photos = [PHOTO];
    const made = await place(answer(), current);
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.edit.inputs.masks).toBeUndefined();
    expect(made.edit.inputs.photos).toBeUndefined();
  });

  it("drops a behind item that cannot last 1 s before the reel ends, with the reason", async () => {
    const made = await place(
      answer((a) => {
        a.accents = [];
        // No transition: nothing else shows while one runs.
        a.transitions = [];
        a.photos = [{ photo_id: PHOTO, from: "w0001", to: "w0010", reason: "mood" }];
        // Said 0.64 s before the reel ends.
        a.big_words = [{ word: "w0010" }];
      }),
    );
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.edit.tracks.behind?.map((item) => item.id)).toEqual(["photo-1"]);
    // The placed photo keeps the answer's reason.
    expect(made.edit.tracks.behind?.[0]).toMatchObject({ kind: "photo", reason: "mood" });
    expect(made.record).toContainEqual(
      expect.objectContaining({ item: "big-word-1", action: "dropped", rule: "big-word-time" }),
    );
  });
});

describe("decideCounts and usedFreeField", () => {
  it("counts accents, transitions, the title, the hook and fixed words", () => {
    const tracks = structuredClone(short.edit.tracks);
    tracks.captions[9]!.text = "Studio";
    // Same as its default text: not a fix.
    tracks.captions[0]!.text = "this";
    tracks.overlays.push(
      {
        id: "title",
        kind: "accent",
        start: { reel: "start" },
        end: { word: "w0004", edge: "end" },
        text: "A test",
      },
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
      id: "dim-a",
      type: "dim",
      start: { word: "w0006" },
      end: { word: "w0008", edge: "end" },
    });
    const edit = { ...short.edit, tracks };
    expect(decideCounts(edit, short.transcript, ISSEBYA_PRESET)).toEqual({
      accents: 1,
      transitions: 1,
      title: true,
      hook: true,
      wordsFixed: 1,
      behindPhotos: 0,
      behindWords: 0,
    });
    expect(usedFreeField(edit)).toBe(false);
    tracks.overlays[1]!.style = { "letter-spacing": "2px" };
    expect(usedFreeField(edit)).toBe(true);
  });
});
