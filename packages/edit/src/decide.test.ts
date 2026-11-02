import { describe, expect, it } from "vitest";
import {
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
  return { tracks: edit.tracks, change_summary: "no change", unexpressed: [], free_field: [] };
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
  }
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
    });
    expect(usedFreeField(edit)).toBe(false);
    tracks.overlays[1]!.style = { "letter-spacing": "2px" };
    expect(usedFreeField(edit)).toBe(true);
  });
});
