import { describe, expect, it } from "vitest";
import { maskSpans } from "./behind.ts";
import { build } from "./build.ts";
import { decideJsonSchema, editFromAnswer, hookJsonSchema } from "./decide.ts";
import { type EngineInput, choicesOf } from "./engine-input.ts";
import { MOVABLE_COMPONENTS, isMovable } from "./owner-edit.ts";
import { ownerTextOf } from "./owner-text.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { FIXTURES, PLACED_FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import type { Transcript } from "./transcript.ts";
import { pickVariants } from "./variant-picker.ts";

// THE FREEZE TESTS of the component template plan (app_docs/component-template.md,
// step 0). Each one saves today's output byte for byte under testdata/freeze/,
// so the refactor steps can prove they change nothing a viewer or the AI can
// see. A deliberate change to any of these outputs is a decision: refresh the
// file with `yarn workspace @edit-issebya/edit vitest run -u component-freeze`
// and say why in the commit, then run the worker's `decision-trace-freeze` and
// the studio's `component-freeze` tests (they read these files). A new fixture
// legitimately extends `choices-of-fixtures.json` and `every-variants.json`.
// No file here holds prompt wording: they hold the
// answer's shape, word ids, times and boxes.

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;
const withHook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const withList = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;
const { transcript } = hand;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const freeze = (name: string) => `./testdata/freeze/${name}`;

// One answer that uses every component the curator and the hook call can
// pick: the accents, big word, visual and list of the transitions fixture, the
// written hook of the hook fixture and a QUESTION no fixture has.
export function everyComponentInput(): EngineInput {
  const listed = choicesOf(withList.edit, transcript, ISSEBYA_PRESET);
  const hooked = choicesOf(withHook.edit, transcript, ISSEBYA_PRESET);
  return {
    ...listed,
    questions: [{ from: "w134", to: "w141" }],
    hook: hooked.hook,
  };
}

function withPlaceholderMasks(edit: Edit, spoken: Transcript): Edit {
  const masks = maskSpans(edit, spoken, ISSEBYA_PRESET).map((span, index) => ({
    step: "cutout" as const,
    fingerprint: String(index + 1).repeat(64),
    file: "mask.mp4",
    start: span.start,
    end: span.end,
  }));
  return { ...edit, inputs: { ...edit.inputs, ...(masks.length > 0 ? { masks } : {}) } };
}

async function placeEveryComponent() {
  const measurer = await nodeMeasurer();
  const made = editFromAnswer(
    hand.edit,
    everyComponentInput(),
    ISSEBYA_PRESET,
    transcript,
    hand.headTrack,
    measurer,
  );
  if (!made.ok) throw new Error(made.reasons.join("; "));
  const built = build(
    withPlaceholderMasks(made.edit, transcript),
    transcript,
    hand.headTrack,
    ISSEBYA_PRESET,
    measurer,
    { engineRecord: made.record },
  );
  return { made, built };
}

describe("component freeze", () => {
  it("sends the AI the same answer schemas, byte for byte", async () => {
    await expect(json(decideJsonSchema(ISSEBYA_PRESET, transcript))).toMatchFileSnapshot(
      freeze("decide-answer.schema.json"),
    );
    await expect(json(hookJsonSchema(ISSEBYA_PRESET))).toMatchFileSnapshot(
      freeze("hook-answer.schema.json"),
    );
  });

  it("covers every component in the one answer it places", async () => {
    const { made } = await placeEveryComponent();
    const components = new Set(made.record.map((note) => note.component));
    expect([...components].sort()).toEqual(
      ["ACCENT", "BIGWORD", "CAPTION", "HOOK", "LIST", "QUESTION", "VISUAL"].sort(),
    );
  });

  it("places the same edit and writes the same engine notes", async () => {
    const { made } = await placeEveryComponent();
    await expect(json(everyComponentInput())).toMatchFileSnapshot(freeze("every-input.json"));
    await expect(json(made.edit.tracks)).toMatchFileSnapshot(freeze("every-tracks.json"));
    await expect(json(made.record)).toMatchFileSnapshot(freeze("every-record.json"));
    await expect(json(Object.fromEntries(pickVariants(everyComponentInput())))).toMatchFileSnapshot(
      freeze("every-variants.json"),
    );
  });

  it("lists the same placed components and the owner's edit rights on each", async () => {
    const { made, built } = await placeEveryComponent();
    await expect(json(built.components)).toMatchFileSnapshot(freeze("every-components.json"));
    const context = { transcript, preset: ISSEBYA_PRESET };
    // What an inline text edit may change: the component's own text, or each
    // of its parts' (a list's lead-in and key phrase, a caption group).
    const rights = built.components.map((component) => ({
      id: component.id,
      component: component.component,
      movable: isMovable(component),
      text: ownerTextOf(made.edit, { id: component.id }, context),
      parts: Object.fromEntries(
        (component.parts ?? []).map((part) => [
          part.id,
          ownerTextOf(made.edit, { id: component.id, part: part.id }, context),
        ]),
      ),
    }));
    await expect(json({ movable: MOVABLE_COMPONENTS, placed: rights })).toMatchFileSnapshot(
      freeze("every-owner-rights.json"),
    );
  });

  it("reads the same picks back from every stored fixture version", () => {
    const read = Object.fromEntries(
      PLACED_FIXTURES.map((fixture) => [
        fixture.name,
        choicesOf(fixture.edit, fixture.transcript, ISSEBYA_PRESET),
      ]),
    );
    return expect(json(read)).toMatchFileSnapshot(freeze("choices-of-fixtures.json"));
  });
});
