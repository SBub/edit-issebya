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
import { FONT_KEYS, ISSEBYA_PRESET, TRANSITION_TYPES } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;

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

function answerOf(edit: Edit) {
  return {
    tracks: edit.tracks,
    change_title: "No change",
    change_summary: "no change",
    unexpressed: [],
    free_field: [],
    behind_rules: { photos: "keep", big_word: "keep" },
  };
}

describe("decideJsonSchema", () => {
  for (const fixture of [hand, short]) {
    it(`is generated for ${fixture.name}: its word ids, the preset's fonts and transitions, closed objects, its duration`, () => {
      const schema = decideJsonSchema(ISSEBYA_PRESET, fixture.transcript, fixture.edit.duration);
      const ids = fixture.transcript.words.map((word) => word.id);
      const wordEnums = enumsUnder(schema, "word");
      expect(wordEnums.length).toBeGreaterThan(0);
      for (const list of wordEnums) expect(list).toEqual(ids);
      const fonts = enumsUnder(schema, "font");
      expect(fonts.length).toBeGreaterThan(0);
      for (const list of fonts) expect(list).toEqual([...FONT_KEYS]);
      const types = enumsUnder(schema, "type");
      expect(types).toEqual([[...TRANSITION_TYPES]]);

      let objects = 0;
      walk(schema, (node) => {
        if (node.type !== "object" || !node.properties) return;
        objects += 1;
        expect(node.additionalProperties).toBe(false);
      });
      expect(objects).toBeGreaterThan(5);

      const timeMaxima: unknown[] = [];
      walk(schema, (node, key) => {
        if (key === "time") timeMaxima.push(node.maximum);
      });
      expect(timeMaxima.length).toBeGreaterThan(0);
      for (const max of timeMaxima) expect(max).toBe(fixture.edit.duration);
    });

    it(`targets draft-07 for ${fixture.name}, with the same constraints as the 2020-12 output`, () => {
      const duration = fixture.edit.duration;
      const schema = decideJsonSchema(ISSEBYA_PRESET, fixture.transcript, duration);
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(JSON.stringify(schema)).not.toContain("2020-12");
      const draft2020: Json = z.toJSONSchema(
        decideAnswerSchemaFor(ISSEBYA_PRESET, fixture.transcript, duration),
        { target: "draft-2020-12", io: "output", reused: "inline" },
      );
      expect({ ...schema, $schema: null }).toEqual({ ...draft2020, $schema: null });
      expect(Object.keys(schema.properties as Json)).toEqual([
        "tracks",
        "change_title",
        "change_summary",
        "unexpressed",
        "free_field",
        "behind_rules",
      ]);
    });
  }
});

describe("decideJsonSchema tracks", () => {
  it("has no cut-out track, and an optional behind track", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript, hand.edit.duration) as {
      properties: { tracks: { properties: Record<string, unknown>; required: string[] } };
    };
    const tracks = schema.properties.tracks;
    expect(Object.keys(tracks.properties)).toEqual([
      "footage",
      "captions",
      "overlays",
      "transitions",
      "sounds",
      "behind",
    ]);
    expect(tracks.required).not.toContain("cutout");
    expect(tracks.required).not.toContain("behind");
  });
});

describe("the behind track in the decide answer", () => {
  const PHOTO = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";
  const OTHER = "1f2e3d4c-5b6a-4789-8a7b-6c5d4e3f2a1b";
  const words = hand.transcript.words;
  // Word anchors about three seconds apart.
  const first = words.findIndex((word) => word.start > 2);
  const last = words.findIndex((word) => word.end > words[first]!.start + 3);
  const photo = {
    id: "behind-photo",
    kind: "photo" as const,
    photo_id: PHOTO,
    spot: "left" as const,
    start: { word: words[first]!.id },
    end: { word: words[last]!.id, edge: "start" as const },
  };
  const answerWith = (behind: unknown[]) => ({
    ...answerOf(hand.edit),
    tracks: { ...hand.edit.tracks, cutout: undefined, behind },
  });

  it("takes a photo of the library and names it in the JSON Schema enum", () => {
    const parsed = parseDecideAnswer(
      answerWith([photo]),
      ISSEBYA_PRESET,
      hand.transcript,
      hand.edit.duration,
      [PHOTO],
    );
    expect(parsed.ok).toBe(true);
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript, hand.edit.duration, [PHOTO]);
    expect(enumsUnder(schema, "photo_id")).toEqual([[PHOTO]]);
    expect(enumsUnder(schema, "spot")).toEqual([["top", "left", "right"]]);
  });

  it("refuses a photo outside the library", () => {
    const parsed = parseDecideAnswer(
      answerWith([{ ...photo, photo_id: OTHER }]),
      ISSEBYA_PRESET,
      hand.transcript,
      hand.edit.duration,
      [PHOTO],
    );
    expect(parsed.ok).toBe(false);
    const none = parseDecideAnswer(
      answerWith([photo]),
      ISSEBYA_PRESET,
      hand.transcript,
      hand.edit.duration,
    );
    expect(none.ok).toBe(false);
  });

  it("passes the behind track through and drops the current masks and photos", () => {
    const current = structuredClone(hand.edit);
    current.inputs.masks = [
      { step: "cutout", fingerprint: "f".repeat(64), file: "mask.mp4", start: 1, end: 4 },
    ];
    current.inputs.photos = [PHOTO];
    const made = editFromAnswer(
      current,
      { tracks: { ...hand.edit.tracks, behind: [photo] } },
      ISSEBYA_PRESET,
      hand.transcript,
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.edit.tracks.behind).toEqual([photo]);
    expect(made.edit.inputs.masks).toBeUndefined();
    expect(made.edit.inputs.photos).toBeUndefined();
    expect(decideCounts(made.edit, hand.transcript, ISSEBYA_PRESET)).toMatchObject({
      behindPhotos: 1,
      behindWords: 0,
    });
  });
});

describe("the behind limits and rules in the decide answer", () => {
  const PHOTO = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";
  const words = hand.transcript.words;
  const duration = hand.edit.duration;
  // Three-second stretches of the reel, starting on words far apart.
  const at = (from: number) => {
    const first = words.findIndex((word) => word.start > from);
    const last = words.findIndex((word) => word.end > words[first]!.start + 3);
    return { start: { word: words[first]!.id }, end: { word: words[last]!.id, edge: "start" } };
  };
  const photo = (id: string, from: number, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "photo",
    photo_id: PHOTO,
    spot: "left",
    ...at(from),
    ...extra,
  });
  // A big word showing a word spoken in its own stretch.
  const spokenFrom = at(10);
  const spokenWord = words.find((word) => word.id === (spokenFrom.start as { word: string }).word)!;
  const bigWord = (text: string) => ({ id: "big", kind: "word", text, ...spokenFrom });
  const answerWith = (behind: unknown[], rules = { photos: "keep", big_word: "keep" }) => ({
    ...answerOf(hand.edit),
    tracks: { ...hand.edit.tracks, cutout: undefined, behind },
    behind_rules: rules,
  });
  const parse = (answer: unknown, rules: DecideRules = NO_RULES, ids = [PHOTO]) =>
    parseDecideAnswer(answer, ISSEBYA_PRESET, hand.transcript, duration, ids, rules);
  const reasonsOf = (result: ReturnType<typeof parse>) =>
    result.ok ? "" : result.reasons.join("\n");
  const forbidPhotos: DecideRules = { requested: false, forbid: { photos: true, bigWord: false } };

  it("caps the behind track and lists the rules in the draft-07 JSON Schema", () => {
    const schema = decideJsonSchema(ISSEBYA_PRESET, hand.transcript, duration, [PHOTO]) as {
      $schema: string;
      properties: {
        tracks: { properties: { behind: { maxItems: number } } };
        behind_rules: { required: string[] };
      };
    };
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.properties.tracks.properties.behind.maxItems).toBe(3);
    expect(enumsUnder(schema, "photo_id")).toEqual([[PHOTO]]);
    expect(schema.properties.behind_rules.required).toEqual(["photos", "big_word"]);
    expect(enumsUnder(schema, "photos")).toEqual([["keep"]]);
    expect(enumsUnder(schema, "big_word")).toEqual([["keep"]]);
    const requested = decideJsonSchema(ISSEBYA_PRESET, hand.transcript, duration, [PHOTO], {
      ...NO_RULES,
      requested: true,
    });
    expect(enumsUnder(requested, "photos")).toEqual([["keep", "forbid", "allow"]]);
    expect(enumsUnder(requested, "big_word")).toEqual([["keep", "forbid", "allow"]]);
  });

  it("accepts two photos and the spoken key word", () => {
    const answer = answerWith([photo("a", 1), photo("b", 20), bigWord(spokenWord.text)]);
    expect(parse(answer)).toMatchObject({ ok: true });
  });

  it("refuses an unknown photo id, a third photo and a 5-second photo", () => {
    const unknown = photo("a", 1, { photo_id: "1f2e3d4c-5b6a-4789-8a7b-6c5d4e3f2a1b" });
    expect(parse(answerWith([unknown])).ok).toBe(false);
    const three = answerWith([photo("a", 1), photo("b", 20), photo("c", 30)]);
    expect(reasonsOf(parse(three))).toMatch(/behind c: a third photo; at most 2 photos per reel/);
    const long = photo("a", 1, { start: { time: 0 }, end: { time: 5 } });
    expect(reasonsOf(parse(answerWith([long])))).toMatch(/behind a: lasts 5\.000 s/);
  });

  it("refuses every photo id with an empty library", () => {
    expect(parse(answerWith([photo("a", 1)]), NO_RULES, []).ok).toBe(false);
    expect(
      enumsUnder(decideJsonSchema(ISSEBYA_PRESET, hand.transcript, duration), "photo_id"),
    ).toEqual([]);
  });

  it("refuses a photo under a stored forbid with keep, accepts it with allow on a request", () => {
    expect(reasonsOf(parse(answerWith([photo("a", 1)]), forbidPhotos))).toMatch(
      /behind a: photos are switched off for this reel by the owner; leave them out/,
    );
    const lifted = answerWith([photo("a", 1)], { photos: "allow", big_word: "keep" });
    expect(parse(lifted, { ...forbidPhotos, requested: true })).toMatchObject({ ok: true });
  });

  it("refuses forbid and allow without a request", () => {
    const answer = answerWith([], { photos: "forbid", big_word: "keep" });
    expect(parse(answer).ok).toBe(false);
    expect(parse(answer, { ...NO_RULES, requested: true })).toMatchObject({ ok: true });
  });

  it("refuses a photo in the same answer that forbids photos", () => {
    const answer = answerWith([photo("a", 1)], { photos: "forbid", big_word: "keep" });
    expect(reasonsOf(parse(answer, { ...NO_RULES, requested: true }))).toMatch(
      /photos are switched off/,
    );
  });

  it("refuses an unspoken big word on the automatic run, accepts it on a request", () => {
    const answer = answerWith([bigWord("ZEBRA")]);
    expect(reasonsOf(parse(answer))).toMatch(
      /behind big: the big word must be one of the words spoken while it shows/,
    );
    expect(parse(answer, { ...NO_RULES, requested: true })).toMatchObject({ ok: true });
  });

  it("applies the rules to the stored flags", () => {
    const stored = { photos: true, bigWord: false };
    expect(applyBehindRules(stored, { photos: "keep", big_word: "keep" })).toEqual(stored);
    expect(applyBehindRules(stored, { photos: "allow", big_word: "forbid" })).toEqual({
      photos: false,
      bigWord: true,
    });
  });
});

describe("parseDecideAnswer", () => {
  const parse = (answer: unknown) =>
    parseDecideAnswer(answer, ISSEBYA_PRESET, hand.transcript, hand.edit.duration);

  function withCaption(change: (caption: Json) => void) {
    const answer = structuredClone(answerOf(hand.edit)) as unknown as {
      tracks: { captions: Json[] };
    };
    change(answer.tracks.captions[3]!);
    return answer;
  }

  function refused(answer: unknown): string {
    const result = parse(answer);
    if (result.ok) throw new Error("expected the answer to be refused");
    return result.reasons.join("\n");
  }

  it("accepts the hand fixture's tracks", () => {
    expect(parse(answerOf(hand.edit))).toMatchObject({ ok: true });
  });

  it("refuses a word id of another reel", () => {
    const foreign = short.transcript.words.find(
      (word) => !hand.transcript.words.some((own) => own.id === word.id),
    )!;
    expect(refused(withCaption((caption) => (caption.start = { word: foreign.id })))).toMatch(
      /item cw3 \(captions\[3\]\.start/,
    );
  });

  it("refuses a time past the reel's end", () => {
    const time = hand.edit.duration + 1;
    expect(refused(withCaption((caption) => (caption.end = { time })))).toMatch(
      /item cw3 \(captions\[3\]\.end/,
    );
  });

  it("refuses a font outside the preset", () => {
    expect(refused(withCaption((caption) => (caption.font = "comic-sans")))).toMatch(
      /item cw3 \(captions\[3\]\.font\)/,
    );
  });

  it("refuses a position outside the safe box", () => {
    expect(
      refused(withCaption((caption) => (caption.position = { x: 900, y: 700, align: "left" }))),
    ).toMatch(/item cw3 \(captions\[3\]\.position\.x\)/);
  });

  it("refuses a free_field entry with a malformed item id", () => {
    expect(
      refused({ ...answerOf(hand.edit), free_field: [{ item: "Bad Id", reason: "x" }] }),
    ).toMatch(/free_field/);
  });

  it("requires a change title of 1 to 60 characters", () => {
    const untitled: Partial<ReturnType<typeof answerOf>> = answerOf(hand.edit);
    delete untitled.change_title;
    expect(refused(untitled)).toMatch(/change_title/);
    expect(refused({ ...answerOf(hand.edit), change_title: "" })).toMatch(/change_title/);
    expect(refused({ ...answerOf(hand.edit), change_title: "x".repeat(61) })).toMatch(
      /change_title/,
    );
    expect(
      parse({ ...answerOf(hand.edit), change_title: "Transitions made longer" }),
    ).toMatchObject({ ok: true });
  });
});

describe("editFromAnswer", () => {
  it("keeps the current version's inputs and duration", () => {
    const current = { ...short.edit, duration: short.edit.duration };
    const result = editFromAnswer(current, answerOf(short.edit), ISSEBYA_PRESET, short.transcript);
    if (!result.ok) throw new Error(result.reasons.join("; "));
    expect(result.edit.inputs).toEqual(short.edit.inputs);
    expect(result.edit.duration).toBe(short.edit.duration);
    expect(result.edit).toEqual(short.edit);
  });

  it("drops a cut-out track the answer carries anyway", () => {
    const tracks = {
      ...structuredClone(short.edit.tracks),
      cutout: [{ id: "cutout", start: { reel: "start" }, end: { reel: "end" } }],
    } as Edit["tracks"];
    const result = editFromAnswer(short.edit, { tracks }, ISSEBYA_PRESET, short.transcript);
    if (!result.ok) throw new Error(result.reasons.join("; "));
    expect(result.edit.tracks).not.toHaveProperty("cutout");
  });

  it("refuses an id used twice", () => {
    const tracks = structuredClone(short.edit.tracks);
    tracks.captions[1]!.id = tracks.captions[0]!.id;
    const result = editFromAnswer(short.edit, { tracks }, ISSEBYA_PRESET, short.transcript);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasons.join("\n")).toMatch(/caption cw0001: id used twice/);
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
