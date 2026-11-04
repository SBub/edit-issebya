import { describe, expect, it } from "vitest";
import type { DecideAnswer } from "./decide.ts";
import {
  checklistOutcome,
  editorialJsonSchema,
  mergeEditorial,
  parseEditorialAnswer,
} from "./editorial.ts";
import type { UnplacedItem } from "./engine.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";

const { transcript } = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";
const OTHER = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";

const PHOTO_LEFT: UnplacedItem = {
  ref: "photos[0]",
  id: "photo-1",
  kind: "photo",
  from: "w84",
  to: "w99",
  photo_id: PHOTO,
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
  ref: "big_word",
  id: "big-word",
  kind: "big_word",
  from: "w76",
  to: "w76",
  requested: false,
  why: "no-room",
};

const ANSWER: DecideAnswer = {
  accents: [
    { from: "w2", to: "w3", title: false },
    { from: "w26", to: "w28", title: false },
  ],
  big_word: null,
  photos: [
    { photo_id: PHOTO, from: "w84", to: "w99" },
    { photo_id: OTHER, from: "w117", to: "w133" },
  ],
  transitions: [],
  word_fixes: [],
  checklist: [
    { ask: "add images behind me", wants: "1 to 2 photos", fulfilled_by: ["photos[0]"] },
    { ask: "more photos", wants: "another photo", fulfilled_by: ["photos[1]"] },
  ],
  behind_rules: { photos: "keep", big_word: "keep" },
  unexpressed: [],
};

function reasons(json: unknown, unplaced: UnplacedItem[], photoIds = [PHOTO, OTHER]) {
  const parsed = parseEditorialAnswer(json, transcript, unplaced, photoIds);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reasons.join("\n");
}

describe("the editorial answer", () => {
  it("is one choice per left-out item: a missing or repeated item is refused", () => {
    const one = { item: "photos[0]", skip: false, from: "w100", to: "w112" };
    expect(parseEditorialAnswer({ choices: [one] }, transcript, [PHOTO_LEFT], [PHOTO]).ok).toBe(
      true,
    );
    expect(reasons({ choices: [] }, [PHOTO_LEFT])).toContain("no choice for photos[0]");
    expect(reasons({ choices: [one, one] }, [PHOTO_LEFT, ACCENT_LEFT])).toContain(
      "photos[0] is chosen twice",
    );
    expect(reasons({ choices: [{ ...one, item: "photos[1]" }] }, [PHOTO_LEFT])).toMatch(
      /choices\.0\.item/,
    );
  });

  it("needs a reason on a skip and no words with it", () => {
    expect(reasons({ choices: [{ item: "photos[0]", skip: true }] }, [PHOTO_LEFT])).toContain(
      "a skip says why",
    );
    expect(
      reasons(
        { choices: [{ item: "photos[0]", skip: true, why: "no match", from: "w1", to: "w2" }] },
        [PHOTO_LEFT],
      ),
    ).toContain("a skip names no words and no photo");
  });

  it("takes a photo id only on a photo, the big word on one word, words in order", () => {
    expect(
      reasons(
        { choices: [{ item: "accents[0]", skip: false, from: "w26", to: "w27", photo_id: PHOTO }] },
        [ACCENT_LEFT],
      ),
    ).toContain("accents[0] is not a photo");
    expect(
      reasons({ choices: [{ item: "big_word", skip: false, from: "w66", to: "w67" }] }, [BIG_LEFT]),
    ).toContain("the big word is one word");
    expect(
      reasons({ choices: [{ item: "photos[0]", skip: false, from: "w112", to: "w100" }] }, [
        PHOTO_LEFT,
      ]),
    ).toContain("ends on w100, before it starts on w112");
    expect(
      reasons({ choices: [{ item: "photos[0]", skip: false, from: "w100" }] }, [PHOTO_LEFT]),
    ).toContain("names its words with from and to");
  });

  it("has meaning only and the decide answer's draft-07 settings", () => {
    const schema = editorialJsonSchema(transcript, [PHOTO_LEFT], [PHOTO]);
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    const text = JSON.stringify(schema);
    expect(text).toContain('"additionalProperties":false');
    for (const word of ["start", "end", "seconds", "x", "y", "size", "spot", "position"]) {
      expect(text).not.toContain(`"${word}":`);
    }
  });
});

describe("mergeEditorial", () => {
  it("replaces a chosen item's words (and photo) in place, with a note", () => {
    const { answer, notes } = mergeEditorial(
      ANSWER,
      {
        choices: [{ item: "photos[0]", skip: false, from: "w100", to: "w112", photo_id: OTHER }],
      },
      [PHOTO_LEFT],
      transcript,
      ISSEBYA_PRESET,
    );
    expect(answer.photos[0]).toEqual({ photo_id: OTHER, from: "w100", to: "w112" });
    expect(answer.photos[1]).toEqual(ANSWER.photos[1]);
    expect(answer.checklist).toEqual(ANSWER.checklist);
    expect(notes).toEqual([
      expect.objectContaining({ item: "photo-1", action: "moved", rule: "editorial" }),
    ]);
    expect(notes[0]!.reason).toMatch(
      /^the editor moved photo 1 to ".+" \(w100 to w112\) with another photo: no room on its sentence$/,
    );
  });

  it("removes a skipped item and re-indexes the checklist links", () => {
    const why = "Nothing else in the reel matches this photo: add a photo of your team";
    const { answer, notes } = mergeEditorial(
      ANSWER,
      { choices: [{ item: "photos[0]", skip: true, why }] },
      [PHOTO_LEFT],
      transcript,
      ISSEBYA_PRESET,
    );
    expect(answer.photos).toEqual([ANSWER.photos[1]]);
    expect(answer.checklist).toEqual([
      { ask: "add images behind me", wants: "1 to 2 photos", fulfilled_by: [], why_not: why },
      { ask: "more photos", wants: "another photo", fulfilled_by: ["photos[0]"] },
    ]);
    expect(notes).toEqual([
      {
        item: "photo-1",
        action: "dropped",
        rule: "editorial",
        reason: `the editor left out photo 1: ${why}`,
      },
    ]);
  });
});

describe("checklistOutcome", () => {
  const drop = {
    item: "photo-1",
    action: "dropped" as const,
    rule: "no-room",
    reason: "photo 1: every photo spot is under captions or the face from 22.80 s to 26.03 s",
  };

  it("marks a placed link done, a dropped one not done with the reason and what to do", () => {
    expect(checklistOutcome(ANSWER.checklist, { unplaced: [PHOTO_LEFT], record: [drop] })).toEqual([
      {
        ask: "add images behind me",
        wants: "1 to 2 photos",
        fulfilled_by: ["photos[0]"],
        done: false,
        reason: `${drop.reason}; ask for it on another sentence or add a photo that matches another part`,
      },
      {
        ask: "more photos",
        wants: "another photo",
        fulfilled_by: ["photos[1]"],
        done: true,
        reason: null,
      },
    ]);
  });

  it("marks a linked transition done only when the engine kept it", () => {
    const ask = {
      ask: "a transition on the list",
      wants: "1 numbered",
      fulfilled_by: ["transitions[0]"],
    };
    const rate = {
      item: "transition-1",
      action: "dropped" as const,
      rule: "transition-rate",
      reason:
        'transition 1 (numbered) on "fair pay" dropped: about one transition per 7 s, this reel has room for 2',
    };
    expect(checklistOutcome([ask], { unplaced: [], record: [] })[0]).toMatchObject({
      done: true,
      reason: null,
    });
    expect(checklistOutcome([ask], { unplaced: [], record: [rate] })[0]).toMatchObject({
      done: false,
      reason: `${rate.reason}; ask for it on another phrase, or for fewer transitions`,
    });
  });

  it("gives an ask with no link its why_not, else a plain default", () => {
    const why = "Your photo library is empty: upload photos first";
    expect(
      checklistOutcome(
        [
          { ask: "photos", wants: "1 photo", fulfilled_by: [], why_not: why },
          { ask: "music", wants: "a song", fulfilled_by: [] },
          { ask: "keep the rules", wants: "no change", fulfilled_by: ["behind_rules"] },
        ],
        { unplaced: [], record: [] },
      ).map(({ done, reason }) => ({ done, reason })),
    ).toEqual([
      { done: false, reason: why },
      { done: false, reason: "nothing in this version does it" },
      { done: true, reason: null },
    ]);
  });
});
