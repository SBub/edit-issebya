import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { captionBlocks } from "./caption-blocks.ts";
import type { PlacedComponent } from "./components.ts";
import { editFromAnswer } from "./decide.ts";
import { choicesOf } from "./engine-input.ts";
import { FONT_PAIRS, type FontPairId } from "./font-pairs.ts";
import { OWNER_CARRY_RULE, carryOwnerEdits } from "./owner-carry.ts";
import {
  type WordCorrection,
  applyWordCorrections,
  captionCorrections,
  withWordCorrections,
} from "./owner-corrections.ts";
import { applyOwnerMoves, ownerMoveProblems } from "./owner-edit.ts";
import { applyOwnerTexts, ownerTextOf } from "./owner-text.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { type Edit, parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// A placed version with the hook, two accents, a big word and a card, the
// owner's work on it, and the same answer placed again in another pair.
const hook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const preset = ISSEBYA_PRESET;
const { transcript, headTrack } = hook;
const answer = choicesOf(hook.edit, transcript, preset);

const measurerOf = (pair: FontPairId) => nodeMeasurer(FONT_PAIRS[pair]);

async function componentsOf(edit: Edit) {
  const measurer = await measurerOf(edit.font_pair);
  return build(edit, transcript, headTrack, preset, measurer, { layer: "front" }).components;
}

function byId(components: readonly PlacedComponent[], id: string): PlacedComponent {
  const found = components.find((component) => component.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

const centre = (box: { x: number; width: number }) => box.x + box.width / 2;

// The first caption group with three captions or more, and its block.
function groupOf(edit: Edit) {
  for (const block of captionBlocks(edit, transcript)) {
    const group = block.groups.find((entry) => entry.captions.length >= 3);
    if (group) return { block, group };
  }
  throw new Error("no caption group that long");
}

// The owner's version: an accent and the hook reworded, one caption word
// fixed, the accent and that caption block moved, the big word resized.
async function ownerVersion() {
  const context = { transcript, headTrack, preset, measurer: await measurerOf("classic") };
  const { block, group } = groupOf(hook.edit);
  const words = ownerTextOf(hook.edit, { id: block.id, part: group.id }, context)!.text.split(" ");
  const fixed = [words[0], "FIXED", ...words.slice(2)].join(" ");
  const texted = applyOwnerTexts(
    hook.edit,
    [
      { id: "accent-1", text: "badly disrupted" },
      { id: "hook", text: "Gen Z will not work like you" },
      { id: block.id, part: group.id, text: fixed },
    ],
    context,
  );
  if (!texted.ok) throw new Error(texted.reasons.join("; "));
  const before = await componentsOf(texted.edit);
  const accent = byId(before, "accent-1");
  const captions = byId(before, block.id);
  const word = byId(before, "big-word-1");
  const moved = applyOwnerMoves(
    texted.edit,
    [
      { id: "accent-1", x: accent.x - 60, y: accent.y + 300, size: 90 },
      { id: block.id, x: captions.x, y: captions.y - 120, size: captions.size! },
      { id: "big-word-1", x: word.x, y: word.y, size: 150 },
    ],
    context,
  );
  if (!moved.ok) throw new Error(moved.reasons.join("; "));
  return { edit: moved.edit, block, group, fixed };
}

// The answer placed again by the engine, the owner's version as its current,
// with the reel's transcript corrections (the way a font pair change does it).
async function placedAgain(
  current: Edit,
  pair: FontPairId,
  corrections: readonly WordCorrection[] = [],
): Promise<Edit> {
  const measurer = await measurerOf(pair);
  const made = editFromAnswer(
    { ...current, font_pair: pair },
    withWordCorrections(answer, corrections),
    preset,
    transcript,
    headTrack,
    measurer,
  );
  if (!made.ok) throw new Error(made.reasons.join("; "));
  return applyWordCorrections(made.edit, corrections, { transcript, headTrack, preset, measurer })
    .edit;
}

async function carried(from: Edit, placed: Edit) {
  return carryOwnerEdits(from, placed, {
    transcript,
    headTrack,
    preset,
    fromMeasurer: await measurerOf(from.font_pair),
    measurer: await measurerOf(placed.font_pair),
  });
}

describe("the owner's marks", () => {
  it("names what the owner placed and wrote, and a placement made again has none", async () => {
    const owner = await ownerVersion();
    expect(owner.edit.owner!.texts).toEqual(["accent-1", "hook", ...owner.group.captions].sort());
    expect(owner.edit.owner!.placed).toEqual(
      ["accent-1", "big-word-1", ...owner.block.groups.flatMap((group) => group.captions)].sort(),
    );
    expect(hook.edit.owner).toBeUndefined();
    const again = await placedAgain(owner.edit, "bold");
    expect(again.owner).toBeUndefined();
    // Without a carry the engine writes every text from its words again.
    expect(again.tracks.overlays.find((item) => item.id === "accent-1")!.text).toBeUndefined();
    expect(parseEdit(JSON.parse(JSON.stringify(owner.edit)), preset, transcript).ok).toBe(true);
  });
});

describe("the owner's work carried into another font pair", () => {
  it("keeps every text fix and every place: the box's top, centre line and size, in the new font", async () => {
    const owner = await ownerVersion();
    const from = await componentsOf(owner.edit);
    // The caption fix is the reel's correction: the placement holds it, and
    // the carry adds the two element texts and the three places.
    const corrections = captionCorrections(hook.edit, owner.edit, transcript, preset);
    expect(corrections).toEqual([{ word: expect.any(String), text: "FIXED" }]);
    const result = await carried(owner.edit, await placedAgain(owner.edit, "bold", corrections));
    expect(result.dropped).toBe(0);
    expect(result.kept).toBe(5);
    expect(result.notes.filter((note) => note.outcome === "dropped")).toEqual([]);
    const { edit } = result;
    expect(edit.font_pair).toBe("bold");
    const to = await componentsOf(edit);
    // The texts, each on its own element.
    expect(byId(to, "accent-1").text).toBe("badly disrupted");
    expect(byId(to, "hook").text).toBe("Gen Z will not work like you");
    expect(byId(to, owner.block.id).parts!.find((part) => part.id === owner.group.id)!.text).toBe(
      owner.fixed,
    );
    expect(byId(to, "accent-2").text).toBe(byId(from, "accent-2").text);
    // The places: the owner's top, centre line and size (a box the new font
    // makes too wide for the safe zone is moved in, and noted).
    for (const id of ["accent-1", "big-word-1", owner.block.id]) {
      const was = byId(from, id);
      const now = byId(to, id);
      const noted = result.notes.some((note) => note.item === id);
      if (!noted) {
        expect(now.size, id).toBe(was.size);
        expect(Math.abs(now.y - was.y), id).toBeLessThan(1);
        expect(Math.abs(centre(now) - centre(was)), id).toBeLessThan(1);
      }
    }
    expect(byId(to, "accent-1").size).toBe(90);
    // Nothing leaves the safe zone, and the result is a version like any other.
    expect(ownerMoveProblems(to, ["accent-1", "big-word-1", "hook", owner.block.id])).toEqual([]);
    expect(parseEdit(JSON.parse(JSON.stringify(edit)), preset, transcript).ok).toBe(true);
    // The marks go with it, so the next font pair change carries them again.
    expect(edit.owner!.placed).toEqual(owner.edit.owner!.placed);
    expect(edit.owner!.texts).toEqual(["accent-1", owner.group.captions[1], "hook"].sort());
    const back = await carried(edit, await placedAgain(edit, "classic", corrections));
    expect(back.dropped).toBe(0);
    const again = await componentsOf(back.edit);
    expect(byId(again, "accent-1").text).toBe("badly disrupted");
    expect(byId(again, "accent-1").size).toBe(90);
    expect(Math.abs(byId(again, "accent-1").y - byId(from, "accent-1").y)).toBeLessThan(1);
    expect(
      byId(again, owner.block.id).parts!.find((part) => part.id === owner.group.id)!.text,
    ).toBe(owner.fixed);
  });

  it("does not carry a caption's text from the version: without the reel's correction the caption says its spoken word", async () => {
    const owner = await ownerVersion();
    const result = await carried(owner.edit, await placedAgain(owner.edit, "bold"));
    expect(result.dropped).toBe(0);
    expect(result.kept).toBe(5);
    expect(result.edit.owner!.texts).toEqual(["accent-1", "hook"]);
    const to = await componentsOf(result.edit);
    expect(
      byId(to, owner.block.id).parts!.find((part) => part.id === owner.group.id)!.text,
    ).not.toContain("FIXED");
  });

  it("leaves a version the owner never edited as the engine placed it", async () => {
    const placed = await placedAgain(hook.edit, "bold");
    const result = await carried(hook.edit, placed);
    expect(result).toMatchObject({ kept: 0, dropped: 0, notes: [] });
    expect(result.edit).toEqual(placed);
  });

  it("moves a box that no longer fits the safe zone inside it, with a note, and never drops it", async () => {
    const context = { transcript, headTrack, preset, measurer: await measurerOf("classic") };
    const was = byId(await componentsOf(hook.edit), "hook");
    // The hook as large as the safe zone lets it be in the classic pair.
    let size = was.size!;
    let owner = hook.edit;
    for (let next = size; next <= 400; next += 10) {
      const moved = applyOwnerMoves(
        hook.edit,
        [{ id: "hook", x: 40, y: was.y, size: next }],
        context,
      );
      if (!moved.ok) break;
      if (ownerMoveProblems(await componentsOf(moved.edit), ["hook"]).length > 0) break;
      size = next;
      owner = moved.edit;
    }
    expect(owner.owner).toEqual({ placed: ["hook"], texts: [] });
    for (const pair of ["bold", "retro", "signature"] as const) {
      const result = await carried(owner, await placedAgain(owner, pair));
      const now = byId(await componentsOf(result.edit), "hook");
      expect(result.dropped, pair).toBe(0);
      expect(ownerMoveProblems(await componentsOf(result.edit), ["hook"]), pair).toEqual([]);
      const note = result.notes.find((entry) => entry.item === "hook");
      const centred = Math.abs(centre(now) - centre(byId(await componentsOf(owner), "hook"))) < 1;
      if (now.size !== size || !centred) {
        expect(note, pair).toMatchObject({ rule: OWNER_CARRY_RULE, component: "HOOK" });
        expect(["moved", "shrunk"]).toContain(note!.outcome);
      }
    }
  });
});
