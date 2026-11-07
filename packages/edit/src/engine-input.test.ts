import { describe, expect, it } from "vitest";
import { editFromAnswer } from "./decide.ts";
import { choicesOf } from "./engine-input.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;
const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const transitions = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;

describe("choicesOf", () => {
  it("reads a stored version back as choices by words", () => {
    const choices = choicesOf(behind.edit, behind.transcript, ISSEBYA_PRESET);
    // A library photo of an older version reads back as a visual over its words.
    expect(choices.visuals).toEqual([{ from: "w18", to: "w27" }]);
    // "WORK" is not spoken under it: the first word under it stands in.
    expect(choices.big_words).toEqual([{ word: "w76" }]);
    expect(choices.accents.map((accent) => accent.from)).toEqual(["w29", "w112"]);
    // Saved before the levels: its key phrase is the whole phrase.
    expect(choices.transitions).toEqual([
      { kind: "panel", from: "w126", to: "w133", key_from: "w126" },
    ]);
    expect(choices.word_fixes).toEqual([
      { word: "w89", text: "Gen Z" },
      { word: "w161", text: "want?" },
    ]);
  });

  it("reads a visual back with its description, and no photo id", () => {
    const edit = structuredClone(behind.edit);
    const photo = edit.tracks.behind!.find((item) => item.kind === "photo")!;
    Object.assign(photo, { kind: "visual", id: "visual-1", description: "a messy desk at night" });
    delete (photo as { photo_id?: string }).photo_id;
    delete (photo as { reason?: string }).reason;
    expect(choicesOf(edit, behind.transcript, ISSEBYA_PRESET).visuals).toEqual([
      { from: "w18", to: "w27", description: "a messy desk at night" },
    ]);
  });

  it("reads a transition back as its phrase, its key phrase and its pace or hold", () => {
    const choices = choicesOf(transitions.edit, transitions.transcript, ISSEBYA_PRESET);
    expect(choices.transitions).toEqual([
      { kind: "dim", from: "w26", to: "w33", key_from: "w30" },
      { kind: "numbered", from: "w100", to: "w103", key_from: "w102" },
      { kind: "numbered", from: "w106", to: "w108", key_from: "w107" },
      { kind: "panel", from: "w126", to: "w133", key_from: "w128" },
    ]);
    const edit = structuredClone(transitions.edit);
    edit.tracks.transitions[0]!.pace = "slow";
    edit.tracks.transitions[1]!.hold = "long";
    // Both set: one wish per choice, the pace.
    edit.tracks.transitions[2]!.pace = "slow";
    edit.tracks.transitions[2]!.hold = "long";
    expect(
      choicesOf(edit, transitions.transcript, ISSEBYA_PRESET).transitions.map((t) => t.wish),
    ).toEqual(["slow", "long", "slow", undefined]);
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
      { word: "w76" },
      { word: "w140" },
    ]);
  });

  it("reads a stored card back as a dim over its words", () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.transitions = [
      { id: "card-a", type: "card", start: { word: "w84" }, end: { word: "w99", edge: "end" } },
    ];
    expect(choicesOf(edit, hand.transcript, ISSEBYA_PRESET).transitions).toEqual([
      { kind: "dim", from: "w84", to: "w99", key_from: "w84" },
    ]);
  });

  it("reads a written title as the words spoken under it", () => {
    const edit = structuredClone(short.edit);
    edit.tracks.overlays.push({
      id: "title",
      kind: "accent",
      start: { reel: "start" },
      end: { word: "w0004", edge: "end" },
      text: "A short test",
    });
    expect(choicesOf(edit, short.transcript, ISSEBYA_PRESET).accents).toEqual([
      { from: "w0001", to: "w0004", title: true },
    ]);
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
      // Accents and transitions keep their words; a photo reads back as the
      // words it now shows over.
      expect(read.accents).toEqual(choices.accents);
      expect(read.transitions).toEqual(choices.transitions);
      expect(read.word_fixes).toEqual(choices.word_fixes);
      expect((await place(once, read)).tracks).toEqual(once.tracks);
    }
  });
});
