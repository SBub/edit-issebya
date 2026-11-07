import { describe, expect, it } from "vitest";
import type { DecideAnswer } from "./decide.ts";
import { editorialJsonSchema, mergeEditorial, parseEditorialAnswer } from "./editorial.ts";
import type { UnplacedItem } from "./engine.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";

const { transcript } = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

const VISUAL_LEFT: UnplacedItem = {
  ref: "visuals[0]",
  id: "visual-1",
  kind: "visual",
  from: "w84",
  to: "w99",
  requested: true,
  why: "no-room",
};
const ACCENT_LEFT: UnplacedItem = {
  ref: "accents[0]",
  id: "accent-1",
  kind: "accent",
  from: "w2",
  to: "w3",
  requested: false,
  why: "busy",
};
const BIG_LEFT: UnplacedItem = {
  ref: "big_words[0]",
  id: "big-word-1",
  kind: "big_word",
  from: "w76",
  to: "w76",
  requested: false,
  why: "no-room",
};

const DESCRIPTION = "a messy desk at night";

const ANSWER: DecideAnswer = {
  accents: [
    { from: "w2", to: "w3" },
    { from: "w26", to: "w28" },
  ],
  big_words: [],
  visuals: [
    { from: "w84", to: "w99", description: DESCRIPTION },
    { from: "w117", to: "w133", description: "a calm lake" },
  ],
  transitions: [],
  word_fixes: [],
};

function reasons(json: unknown, unplaced: UnplacedItem[]) {
  const parsed = parseEditorialAnswer(json, transcript, unplaced);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reasons.join("\n");
}

describe("the editorial answer", () => {
  it("is one choice per left-out item: a missing or repeated item is refused", () => {
    const one = { item: "visuals[0]", skip: false, from: "w100", to: "w112" };
    expect(parseEditorialAnswer({ choices: [one] }, transcript, [VISUAL_LEFT]).ok).toBe(true);
    expect(reasons({ choices: [] }, [VISUAL_LEFT])).toContain("no choice for visuals[0]");
    expect(reasons({ choices: [one, one] }, [VISUAL_LEFT, ACCENT_LEFT])).toContain(
      "visuals[0] is chosen twice",
    );
    expect(reasons({ choices: [{ ...one, item: "visuals[1]" }] }, [VISUAL_LEFT])).toMatch(
      /choices\.0\.item/,
    );
  });

  it("needs a reason on a skip and no words with it", () => {
    expect(reasons({ choices: [{ item: "visuals[0]", skip: true }] }, [VISUAL_LEFT])).toContain(
      "a skip says why",
    );
    expect(
      reasons(
        { choices: [{ item: "visuals[0]", skip: true, why: "no match", from: "w1", to: "w2" }] },
        [VISUAL_LEFT],
      ),
    ).toContain("a skip names no words");
  });

  it("names no picture: a photo id is refused, the big word is one word, words in order", () => {
    expect(
      reasons(
        {
          choices: [
            {
              item: "visuals[0]",
              skip: false,
              from: "w100",
              to: "w112",
              photo_id: "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c",
            },
          ],
        },
        [VISUAL_LEFT],
      ),
    ).toContain('Unrecognized key: "photo_id"');
    expect(
      reasons({ choices: [{ item: "big_words[0]", skip: false, from: "w66", to: "w67" }] }, [
        BIG_LEFT,
      ]),
    ).toContain("a big word is one word");
    expect(
      reasons({ choices: [{ item: "visuals[0]", skip: false, from: "w112", to: "w100" }] }, [
        VISUAL_LEFT,
      ]),
    ).toContain("ends on w100, before it starts on w112");
    expect(
      reasons({ choices: [{ item: "visuals[0]", skip: false, from: "w100" }] }, [VISUAL_LEFT]),
    ).toContain("names its words with from and to");
  });

  it("has meaning only and the decide answer's draft-07 settings", () => {
    const schema = editorialJsonSchema(transcript, [VISUAL_LEFT]);
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    const text = JSON.stringify(schema);
    expect(text).toContain('"additionalProperties":false');
    for (const word of ["start", "end", "seconds", "x", "y", "size", "spot", "position"]) {
      expect(text).not.toContain(`"${word}":`);
    }
  });
});

describe("mergeEditorial", () => {
  it("replaces a chosen visual's words in place, keeping its description, with a note", () => {
    const { answer, notes } = mergeEditorial(
      ANSWER,
      { choices: [{ item: "visuals[0]", skip: false, from: "w100", to: "w112" }] },
      [VISUAL_LEFT],
      transcript,
      ISSEBYA_PRESET,
    );
    expect(answer.visuals[0]).toEqual({ from: "w100", to: "w112", description: DESCRIPTION });
    expect(answer.visuals[1]).toEqual(ANSWER.visuals[1]);
    expect(notes).toEqual([
      expect.objectContaining({ item: "visual-1", action: "moved", rule: "editorial" }),
    ]);
    expect(notes[0]!.reason).toMatch(
      /^the editor moved visual 1 to ".+" \(w100 to w112\): no room on its sentence$/,
    );
  });

  it("removes a skipped visual and keeps the others in order", () => {
    const why =
      "No other part of the reel has room for this visual: shorten the sentence before it";
    const { answer, notes } = mergeEditorial(
      ANSWER,
      { choices: [{ item: "visuals[0]", skip: true, why }] },
      [VISUAL_LEFT],
      transcript,
      ISSEBYA_PRESET,
    );
    expect(answer.visuals).toEqual([ANSWER.visuals[1]]);
    expect(notes).toEqual([
      {
        item: "visual-1",
        action: "dropped",
        rule: "editorial",
        reason: `the editor left out visual 1: ${why}`,
      },
    ]);
  });
});

describe("mergeEditorial on big words", () => {
  it("moves one big word, skips another and re-indexes the links to the rest", () => {
    const answer = {
      ...ANSWER,
      big_words: [{ word: "w76" }, { word: "w140" }, { word: "w76" }],
    };
    const second: UnplacedItem = { ...BIG_LEFT, ref: "big_words[1]", id: "big-word-2" };
    const merged = mergeEditorial(
      answer,
      {
        choices: [
          { item: "big_words[0]", skip: false, from: "w66", to: "w66" },
          { item: "big_words[1]", skip: true, why: "No other key word fits here" },
        ],
      },
      [BIG_LEFT, second],
      transcript,
      ISSEBYA_PRESET,
    );
    expect(merged.answer.big_words).toEqual([{ word: "w66" }, { word: "w76" }]);
    expect(merged.notes.map((note) => note.reason)).toEqual([
      expect.stringMatching(/^the editor moved big word 1 to /),
      "the editor left out big word 2: No other key word fits here",
    ]);
  });
});
