import { describe, expect, it } from "vitest";
import { editFromAnswer } from "./decide.ts";
import { choicesOf } from "./engine-input.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech")!;
const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

describe("choicesOf", () => {
  it("reads a stored version back as choices by words", () => {
    const choices = choicesOf(behind.edit, behind.transcript, ISSEBYA_PRESET);
    expect(choices.photos).toEqual([
      { photo_id: "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14", from: "w18", to: "w27" },
    ]);
    // "WORK" is not spoken under it: the first word under it stands in.
    expect(choices.big_word).toEqual({ word: "w76" });
    expect(choices.accents.map((accent) => accent.from)).toEqual(["w29", "w112"]);
    expect(choices.transitions).toEqual([{ kind: "panel", from: "w126", to: "w133" }]);
    expect(choices.word_fixes).toEqual([
      { word: "w89", text: "Gen Z" },
      { word: "w161", text: "want?" },
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
    for (const fixture of [hand, behind]) {
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
