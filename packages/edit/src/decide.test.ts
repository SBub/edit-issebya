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
  usedFreeField,
} from "./decide.ts";
import { WISHES } from "./engine-input.ts";
import { ISSEBYA_PRESET, TRANSITION_TYPES } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";

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
    big_word: null,
    photos: [],
    transitions: [{ kind: "dim", from: "w0006", to: "w0008" }],
    word_fixes: [{ word: "w0010", text: "Studio" }],
    checklist: [],
    behind_rules: { photos: "keep", big_word: "keep" },
    change_title: "Title and one accent added",
    change_summary: "A title opens the reel and one word stands out.",
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
      expect(enumsUnder(schema, "kind")).toEqual([[...TRANSITION_TYPES]]);
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
      "big_word",
      "photos",
      "transitions",
      "word_fixes",
      "checklist",
      "behind_rules",
      "change_title",
      "change_summary",
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

  it("names the library photos, at most the preset's count", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript, [PHOTO]) as {
      properties: { photos: { maxItems: number } };
    };
    expect(enumsUnder(schema, "photo_id")).toEqual([[PHOTO]]);
    expect(schema.properties.photos.maxItems).toBe(ISSEBYA_PRESET.behind.maxPhotos);
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
    const noBigWord = answer((a) => {
      delete a.big_word;
    });
    expect(reasons(noBigWord)).toMatch(/^big_word: /m);
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
      a.big_word = { word: "w0001", wish: "behind" };
    });
    const text = reasons(wished);
    expect(text).toContain(
      "accents.1.wish: a wish only forwards the owner's request; there is none, leave it out",
    );
    expect(text).toMatch(/^big_word\.wish: /m);
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
      a.transitions = [{ kind: "dim", from: "w0008", to: "w0006" }];
    });
    expect(reasons(backwards)).toContain(
      "transitions.0.to: ends on w0006, before it starts on w0008",
    );
    const two = answer((a) => {
      (a.accents as Json[])[1]!.title = true;
    });
    expect(reasons(two)).toContain("accents: only one accent is the title");
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

  it("requires a change title of 1 to 60 characters", () => {
    expect(parse(answer((a) => (a.change_title = ""))).ok).toBe(false);
    expect(parse(answer((a) => (a.change_title = "x".repeat(61)))).ok).toBe(false);
    expect(parse(answer((a) => (a.change_title = "x".repeat(60)))).ok).toBe(true);
  });
});

describe("the request checklist", () => {
  const withAsk = (fulfilledBy: string[]) =>
    answer((a) => {
      a.photos = [{ photo_id: PHOTO, from: "w0001", to: "w0010", wish: "left" }];
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

  it("refuses a link to an item the answer does not have, or not an item at all", () => {
    expect(reasons(withAsk(["photos[1]"]), [PHOTO], REQUEST)).toContain(
      "checklist.0.fulfilled_by: photos[1] is not in the answer",
    );
    expect(reasons(withAsk(["big_word"]), [PHOTO], REQUEST)).toContain(
      "checklist.0.fulfilled_by: big_word is not in the answer",
    );
    expect(reasons(withAsk(["the photo"]), [PHOTO], REQUEST)).toMatch(
      /^checklist\.0\.fulfilled_by\.0: /m,
    );
  });
});

describe("the behind limits and rules in the decide answer", () => {
  const photo = { photo_id: PHOTO, from: "w0001", to: "w0010" };
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

  it("refuses a third photo", () => {
    expect(reasons(withPhotos([photo, photo, photo]), [PHOTO])).toContain(
      "photos: at most 2 photos per reel",
    );
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

  it("refuses the big word while it is forbidden", () => {
    const big = answer((a) => (a.big_word = { word: "w0005" }));
    expect(parse(big).ok).toBe(true);
    expect(reasons(big, [], stored(false, true))).toContain(
      "big_word: the big word is switched off for this reel by the owner",
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
  const place = (json: Json, current = short.edit) => {
    const parsed = parse(json, [PHOTO], REQUEST);
    if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
    return editFromAnswer(current, parsed.answer, ISSEBYA_PRESET, short.transcript, []);
  };

  it("keeps the current version's inputs, duration, footage and sounds", () => {
    const made = place(answer());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.edit.inputs).toEqual(short.edit.inputs);
    expect(made.edit.duration).toBe(short.edit.duration);
    expect(made.edit.tracks.footage).toEqual(short.edit.tracks.footage);
    expect(made.edit.tracks.sounds).toEqual(short.edit.tracks.sounds);
  });

  it("drops the current masks and photos", () => {
    const current = structuredClone(short.edit);
    current.inputs.masks = [
      { step: "cutout", fingerprint: "f".repeat(64), file: "mask.mp4", start: 0, end: 2 },
    ];
    current.inputs.photos = [PHOTO];
    const made = place(answer(), current);
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.edit.inputs.masks).toBeUndefined();
    expect(made.edit.inputs.photos).toBeUndefined();
  });

  it("refuses two behind items at the same time", () => {
    const made = place(
      answer((a) => {
        a.photos = [{ photo_id: PHOTO, from: "w0001", to: "w0010" }];
        a.big_word = { word: "w0005" };
      }),
    );
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.reasons.join("\n")).toMatch(/only one at a time/);
  });
});

describe("decideCounts and usedFreeField", () => {
  it("counts accents, transitions, the title and fixed words", () => {
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
      wordsFixed: 1,
      behindPhotos: 0,
      behindWords: 0,
    });
    expect(usedFreeField(edit)).toBe(false);
    tracks.overlays[1]!.style = { "letter-spacing": "2px" };
    expect(usedFreeField(edit)).toBe(true);
  });
});
