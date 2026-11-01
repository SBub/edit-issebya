import { Ajv2020 } from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type DecideContext,
  answerCounts,
  decideAnswerSchema,
  decideJsonSchema,
  editFromAnswer,
} from "./decide.ts";
import { ISSEBYA } from "./preset.ts";
import { parseEdit } from "./schema.ts";
import { type Fixture, fixtures, rethinkWork } from "./testdata/node.ts";

let context: DecideContext;
let accents: Fixture;
// Where the reference reel's last word ends, plus the tail.
const CLIP = 47.9;

beforeAll(async () => {
  const { transcript } = await rethinkWork();
  context = { transcript, preset: ISSEBYA, clipDuration: CLIP };
  accents = (await fixtures()).find((fixture) => fixture.name === "rethink-work-accents")!;
});

type Tracks = Record<string, Record<string, unknown>[]>;

// The accents fixture's tracks as an answer, with one change.
function answer(change: (tracks: Tracks) => void = () => {}): Record<string, unknown> {
  const tracks = structuredClone((accents.edit as { tracks: Tracks }).tracks);
  change(tracks);
  return {
    tracks,
    change_summary: "accents on two key words and one dimmed line",
    fixed_words: [{ word: "w0010", heard: "rethink", text: "rethink" }],
    unexpressed: [],
    free_field: [{ item: "c-w0005", why: "letter spacing" }],
  };
}

function validator() {
  return new Ajv2020({ allErrors: true }).compile(decideJsonSchema(context));
}

// A def or property of the exported schema, by path.
function at(schema: unknown, ...path: string[]): Record<string, unknown> {
  let node = schema as Record<string, unknown>;
  for (const key of path) node = node[key] as Record<string, unknown>;
  return node;
}

describe("decideJsonSchema", () => {
  it("lists this transcript's word ids, in order, once", () => {
    const schema = decideJsonSchema(context);
    expect(at(schema, "$defs", "wordId").enum).toEqual(
      context.transcript.words.map((word) => word.id),
    );
    expect(JSON.stringify(schema).match(/"w0001"/g)).toHaveLength(1);
  });

  it("closes fonts, colours, sounds and transitions to the preset's", () => {
    const text = JSON.stringify(decideJsonSchema(context));
    const enums = [...text.matchAll(/"enum":(\[[^\]]*\])/g)].map(
      ([, list]) => JSON.parse(list!) as string[],
    );
    expect(enums).toContainEqual(Object.keys(ISSEBYA.fonts));
    expect(enums).toContainEqual(Object.keys(ISSEBYA.colors));
    expect(enums).toContainEqual(Object.keys(ISSEBYA.sounds));
    expect(enums).toContainEqual(ISSEBYA.transitions);
  });

  it("bounds times by the clip and positions by the safe box", () => {
    const text = JSON.stringify(decideJsonSchema(context));
    expect(text).toContain(`"maximum":${CLIP}`);
    for (const bound of [130, 860, 260, 1400]) expect(text).toContain(`imum":${bound}`);
  });

  it("refuses a transcript with no words", () => {
    expect(() => decideJsonSchema({ ...context, transcript: { words: [] } })).toThrow(
      /transcript is empty/,
    );
  });
});

describe("the per-reel answer schema", () => {
  it("accepts a valid answer, in Zod and in the exported JSON Schema", () => {
    expect(decideAnswerSchema(context).safeParse(answer()).success).toBe(true);
    const validate = validator();
    expect(validate(answer()), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalid: [string, (tracks: Tracks) => void][] = [
    ["a word id not in this transcript", (t) => (t.captions![0]!.start = { word: "w9999" })],
    ["a time past the clip's end", (t) => (t.footage![0]!.start = { at: CLIP + 1 })],
    ["a font the preset lacks", (t) => (t.overlays![1]!.style = { font: "comic" })],
    [
      "a position outside the safe box",
      (t) => (t.overlays![0]!.style = { position: { x: 900, y: 600 } }),
    ],
  ];
  for (const [name, change] of invalid) {
    it(`refuses ${name}, in Zod and in the exported JSON Schema`, () => {
      expect(decideAnswerSchema(context).safeParse(answer(change)).success).toBe(false);
      expect(validator()(answer(change))).toBe(false);
    });
  }

  it("is generated per reel: the short clip's schema refuses this reel's late words", async () => {
    const short = (await fixtures()).find((fixture) => fixture.name === "short-speech-baseline")!;
    const shortContext = { transcript: short.transcript, preset: ISSEBYA, clipDuration: 2.69 };
    const late = answer((t) => (t.captions = [t.captions!.at(-1)!]));
    expect(decideAnswerSchema(shortContext).safeParse(late).success).toBe(false);
    expect(new Ajv2020().compile(decideJsonSchema(shortContext))(late)).toBe(false);
  });
});

describe("editFromAnswer and answerCounts", () => {
  it("makes a full edit with the parent's inputs", () => {
    const parsed = decideAnswerSchema(context).parse(answer());
    const inputs = (accents.edit as { inputs: Parameters<typeof editFromAnswer>[1] }).inputs;
    const edit = editFromAnswer(parsed, inputs);
    expect(parseEdit(edit, context)).toEqual(accents.edit);
  });

  it("counts accents, transitions, the title and fixed words", () => {
    const parsed = decideAnswerSchema(context).parse(
      answer((t) =>
        t.overlays!.push({ id: "title", start: { at: 0 }, end: { word: "w0003" }, text: "hi" }),
      ),
    );
    expect(answerCounts(parsed)).toEqual({
      accents: 2,
      transitions: 1,
      title: true,
      fixedWords: 1,
    });
  });
});
