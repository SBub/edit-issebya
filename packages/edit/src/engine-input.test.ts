import { describe, expect, it } from "vitest";
import { editFromAnswer } from "./decide.ts";
import { choicesOf } from "./engine-input.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const transitions = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;

describe("choicesOf", () => {
  it("reads a stored version back as choices by words", () => {
    const choices = choicesOf(behind.edit, behind.transcript, ISSEBYA_PRESET);
    // A VISUAL reads back over its words, with no description when it has none.
    expect(choices.visuals).toEqual([{ from: "w18", to: "w27" }]);
    // "WORK" is not spoken under it: the first word under it stands in.
    expect(choices.big_words).toEqual([{ from: "w76", to: "w76" }]);
    expect(choices.accents.map((accent) => accent.from)).toEqual(["w29", "w112"]);
    expect(choices.lists).toEqual([]);
    expect(choices.word_fixes).toEqual([
      { word: "w89", text: "Gen Z" },
      { word: "w161", text: "want?" },
    ]);
  });

  it("reads a visual back with its description", () => {
    const edit = structuredClone(behind.edit);
    const visual = edit.tracks.behind!.find((item) => item.kind === "visual")!;
    Object.assign(visual, { description: "a messy desk at night" });
    expect(choicesOf(edit, behind.transcript, ISSEBYA_PRESET).visuals).toEqual([
      { from: "w18", to: "w27", description: "a messy desk at night" },
    ]);
  });

  it("reads a list's items back as one list, each as its phrase and its key phrase", () => {
    const choices = choicesOf(transitions.edit, transitions.transcript, ISSEBYA_PRESET);
    expect(choices.lists).toEqual([
      {
        items: [
          { from: "w100", to: "w103", key_from: "w102" },
          { from: "w106", to: "w108", key_from: "w107" },
        ],
      },
    ]);
  });

  it("reads two lists back as two lists, in reel order, each with its items", () => {
    const edit = structuredClone(transitions.edit);
    const [first, second] = edit.tracks.transitions;
    edit.tracks.transitions = [
      { ...first!, list: 1, number: undefined },
      { ...second!, list: 2, number: undefined },
    ];
    const choices = choicesOf(edit, transitions.transcript, ISSEBYA_PRESET);
    expect(choices.lists.map((list) => list.items.map((item) => item.from))).toEqual([
      ["w100"],
      ["w106"],
    ]);
  });

  it("reads every big word back, an older version's one big word as a list of one", () => {
    const edit = structuredClone(behind.edit);
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    edit.tracks.behind!.push({
      ...word,
      id: "big-word-2",
      start: { word: "w140" },
      end: { word: "w142", edge: "end" },
    });
    expect(choicesOf(edit, behind.transcript, ISSEBYA_PRESET).big_words).toEqual([
      { from: "w76", to: "w76" },
      { from: "w140", to: "w140" },
    ]);
  });

  it("reads a two-word big word back as its first and last word", () => {
    const edit = structuredClone(behind.edit);
    const word = edit.tracks.behind!.find((item) => item.kind === "word")!;
    Object.assign(word, { text: "distribution channel", end: { word: "w77", edge: "end" } });
    expect(choicesOf(edit, behind.transcript, ISSEBYA_PRESET).big_words).toEqual([
      { from: "w76", to: "w77" },
    ]);
  });

  it("reads a question overlay back as a question, not an accent", () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.overlays.push({
      id: "question-1",
      kind: "accent",
      start: { word: "w9" },
      end: { word: "w10", edge: "end" },
      words: ["w9", "w10"],
    });
    const choices = choicesOf(edit, hand.transcript, ISSEBYA_PRESET);
    expect(choices.questions).toEqual([{ from: "w9", to: "w10" }]);
    expect(choices.accents.map((accent) => accent.from)).not.toContain("w9");
  });

  it("reads a version with no question as none", () => {
    expect(choicesOf(hand.edit, hand.transcript, ISSEBYA_PRESET).questions).toEqual([]);
  });

  it("round-trips: the choices placed pass as an edit, and read back place the same", async () => {
    for (const fixture of [hand, behind, transitions]) {
      const choices = choicesOf(fixture.edit, fixture.transcript, ISSEBYA_PRESET);
      const place = async (current: typeof fixture.edit, input: typeof choices) => {
        const made = editFromAnswer(
          current,
          input,
          ISSEBYA_PRESET,
          fixture.transcript,
          fixture.headTrack,
          await nodeMeasurer(),
        );
        if (!made.ok) throw new Error(`${fixture.name}: ${made.reasons.join("; ")}`);
        return made.edit;
      };
      const once = await place(fixture.edit, choices);
      const read = choicesOf(once, fixture.transcript, ISSEBYA_PRESET);
      // Accents and transitions keep their words; a visual reads back as the
      // words it now shows over.
      expect(read.accents).toEqual(choices.accents);
      expect(read.lists).toEqual(choices.lists);
      expect(read.word_fixes).toEqual(choices.word_fixes);
      expect((await place(once, read)).tracks).toEqual(once.tracks);
    }
  });
});
