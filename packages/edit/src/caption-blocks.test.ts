import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import {
  CAPTION_BLOCK_PREFIX,
  captionBlocks,
  captionFont,
  captionSize,
  captionText,
  layBlock,
  storedLines,
} from "./caption-blocks.ts";
import type { PlacedComponent } from "./components.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import {
  applyOwnerMoves,
  effectiveMoves,
  ownerMoveProblems,
  ownerMoveRecords,
  ownerSizeRange,
  ownerWrapOptions,
  settleOwnerMove,
} from "./owner-edit.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import { type Fixture, FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// A placed version with the hook, two accents and a big word: its captions are
// sentence blocks the engine placed.
const hook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const preset = ISSEBYA_PRESET;

async function contextOf(fixture: Fixture) {
  return {
    transcript: fixture.transcript,
    headTrack: fixture.headTrack,
    preset,
    measurer: await nodeMeasurer(),
  };
}

async function componentsOf(fixture: Fixture, edit: Edit = fixture.edit) {
  const context = await contextOf(fixture);
  return build(edit, context.transcript, context.headTrack, preset, context.measurer).components;
}

function blockOf(components: readonly PlacedComponent[], id: string): PlacedComponent {
  const found = components.find((component) => component.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

const captionsOf = (edit: Edit) => new Map(edit.tracks.captions.map((item) => [item.id, item]));

// The block with the most captions: the one whose groups and lines say most.
function largestBlock(fixture: Fixture) {
  const blocks = captionBlocks(fixture.edit, fixture.transcript);
  return blocks.reduce((best, block) =>
    block.groups.flat().length + block.groups.flatMap((group) => group.captions).length >
    best.groups.flatMap((group) => group.captions).length + best.groups.flat().length
      ? block
      : best,
  );
}

describe("the caption blocks of a version", () => {
  it("puts every shown caption in one group of one block, each group ending on one moment", () => {
    const blocks = captionBlocks(hook.edit, hook.transcript);
    const resolved = resolveTimeline(hook.edit, hook.transcript);
    const shown = hook.edit.tracks.captions.filter(
      (caption) => caption.hidden_by === undefined && caption.position,
    );
    const grouped = blocks.flatMap((block) => block.groups.flatMap((group) => group.captions));
    expect([...grouped].sort()).toEqual(shown.map((caption) => caption.id).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.id).toBe(`${CAPTION_BLOCK_PREFIX}${block.groups[0]!.id}`);
      expect(block.start).toBe(Math.min(...block.groups.map((group) => group.start)));
      expect(block.end).toBe(Math.max(...block.groups.map((group) => group.end)));
      for (const group of block.groups) {
        expect(group.id).toBe(group.captions[0]);
        for (const id of group.captions) {
          expect(resolved.get(id)!.end).toBeCloseTo(group.end, 3);
        }
      }
    }
    // In time order.
    expect(blocks.map((block) => block.start)).toEqual(
      [...blocks.map((block) => block.start)].sort((a, b) => a - b),
    );
  });

  it("is a component of the built page: one box around its captions for the sentence's whole time", async () => {
    const components = await componentsOf(hook);
    const blocks = captionBlocks(hook.edit, hook.transcript);
    for (const block of blocks) {
      const component = blockOf(components, block.id);
      const own = block.groups
        .flatMap((group) => group.captions)
        .map((id) => blockOf(components, id));
      expect(component).toMatchObject({
        component: "CAPTION",
        start: block.start,
        end: block.end,
        size: own[0]!.size,
        x: Math.min(...own.map((caption) => caption.x)),
        y: Math.min(...own.map((caption) => caption.y)),
        text: own.map((caption) => caption.text).join(" "),
      });
      expect(component.x + component.width).toBeCloseTo(
        Math.max(...own.map((caption) => caption.x + caption.width)),
        6,
      );
      expect(component.parts!.map((part) => part.id)).toEqual(
        block.groups.map((group) => group.id),
      );
      expect(component.parts!.map((part) => part.items)).toEqual(
        block.groups.map((group) => group.captions),
      );
    }
  });

  it("lays a block from its corner on its stored lines exactly where the engine put its captions", async () => {
    const { measurer, transcript } = await contextOf(hook);
    const components = await componentsOf(hook);
    const byId = captionsOf(hook.edit);
    for (const block of captionBlocks(hook.edit, hook.transcript)) {
      const at = blockOf(components, block.id);
      const groups = block.groups.map((group) => {
        const items = group.captions.map((id) => byId.get(id)!);
        return {
          units: items.map((item) => ({
            id: item.id,
            text: captionText(item, transcript, preset),
            font: captionFont(item),
          })),
          lines: storedLines(items),
        };
      });
      const size = captionSize(byId.get(block.groups[0]!.id)!);
      const laid = layBlock(groups, at, size, preset.caption.lineGap, measurer);
      for (const [id, place] of laid.places) {
        expect(place.x, id).toBeCloseTo(byId.get(id)!.position!.x, 2);
        expect(place.y, id).toBeCloseTo(byId.get(id)!.position!.y, 2);
      }
    }
  });
});

describe("a caption block moved by the owner", () => {
  it("moves every caption of the sentence with the box, and nothing else", async () => {
    const context = await contextOf(hook);
    const block = largestBlock(hook);
    const before = blockOf(await componentsOf(hook), block.id);
    const move = { id: block.id, x: before.x + 40, y: before.y - 60, size: before.size! };
    const applied = applyOwnerMoves(hook.edit, [move], context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = blockOf(await componentsOf(hook, applied.edit), block.id);
    expect(after).toMatchObject({ x: move.x, y: move.y, size: before.size });
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
    const was = captionsOf(hook.edit);
    const own = new Set(block.groups.flatMap((group) => group.captions));
    for (const item of applied.edit.tracks.captions) {
      const old = was.get(item.id)!;
      if (!own.has(item.id)) {
        expect(item).toEqual(old);
        continue;
      }
      expect(item.position!.x).toBeCloseTo(old.position!.x + 40, 2);
      expect(item.position!.y).toBeCloseTo(old.position!.y - 60, 2);
      // Its words, its text, its time and its size stay.
      expect({ ...item, position: undefined, size: undefined }).toEqual({
        ...old,
        position: undefined,
        size: undefined,
      });
      expect(captionSize(item)).toBe(captionSize(old));
    }
    expect({ ...applied.edit.tracks, captions: [] }).toEqual({ ...hook.edit.tracks, captions: [] });
  });

  it("resizes about its corner: every caption at the new size, on the same lines", async () => {
    const context = await contextOf(hook);
    const block = largestBlock(hook);
    const before = blockOf(await componentsOf(hook), block.id);
    const size = before.size! - 10;
    const applied = applyOwnerMoves(
      hook.edit,
      [{ id: block.id, x: before.x, y: before.y, size }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = blockOf(await componentsOf(hook, applied.edit), block.id);
    expect(after).toMatchObject({ x: before.x, y: before.y, size });
    expect(after.width).toBeCloseTo((before.width * size) / before.size!, 0);
    expect(after.height).toBeLessThan(before.height);
    const now = captionsOf(applied.edit);
    const was = captionsOf(hook.edit);
    for (const group of block.groups) {
      expect(storedLines(group.captions.map((id) => now.get(id)!))).toEqual(
        storedLines(group.captions.map((id) => was.get(id)!)),
      );
      for (const id of group.captions) expect(now.get(id)!.size).toBe(size);
    }
  });

  it("sets each group again on more lines for a narrower wrap width, between whole captions", async () => {
    const context = await contextOf(hook);
    const block = largestBlock(hook);
    const before = blockOf(await componentsOf(hook), block.id);
    const at = { x: before.x, y: before.y, size: before.size! };
    const options = ownerWrapOptions(hook.edit, block.id, at, context)!;
    expect(options.length).toBeGreaterThan(1);
    // Widest first, each box no wider and never shorter than the one before (a
    // shallow group may take more lines first; a caption wider than the wrap
    // width keeps its line, as a caption is never cut).
    expect(options[0]!.boxWidth).toBeLessThanOrEqual(options[0]!.width + 1e-6);
    for (const [index, option] of options.entries()) {
      if (index > 0) {
        expect(option.boxWidth).toBeLessThanOrEqual(options[index - 1]!.boxWidth + 1e-6);
        expect(option.width).toBeLessThan(options[index - 1]!.width);
        expect(option.boxHeight).toBeGreaterThanOrEqual(options[index - 1]!.boxHeight);
      }
    }
    const narrow = options.at(-1)!;
    const applied = applyOwnerMoves(hook.edit, [{ id: block.id, ...at, width: narrow.width }], {
      ...context,
    });
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = blockOf(await componentsOf(hook, applied.edit), block.id);
    expect(after).toMatchObject({ x: before.x, y: before.y, size: before.size });
    expect(after.width).toBeCloseTo(narrow.boxWidth, 6);
    expect(after.height).toBeCloseTo(narrow.boxHeight, 6);
    expect(after.height).toBeGreaterThan(before.height);
    // One caption a line in the deepest group: a caption is never cut.
    const now = captionsOf(applied.edit);
    const deepest = Math.max(...block.groups.map((group) => group.captions.length));
    expect(
      Math.max(
        ...block.groups.map(
          (group) => storedLines(group.captions.map((id) => now.get(id)!)).length,
        ),
      ),
    ).toBe(deepest);
    // The words and the times are the version's.
    expect(
      applied.edit.tracks.captions.map(({ id, words, start, end }) => ({ id, words, start, end })),
    ).toEqual(
      hook.edit.tracks.captions.map(({ id, words, start, end }) => ({ id, words, start, end })),
    );
  });

  it("is bound to the safe zone like any text: a drag past the edge settles at the edge", async () => {
    const context = await contextOf(hook);
    const block = largestBlock(hook);
    const before = blockOf(await componentsOf(hook), block.id);
    const settled = settleOwnerMove(
      hook.edit,
      { id: block.id, x: -500, y: before.y, size: before.size! },
      context,
    );
    if (!settled.ok) throw new Error(settled.reasons.join("; "));
    const components = await componentsOf(hook, settled.edit);
    expect(blockOf(components, block.id).x).toBe(SAFE_ZONE.box.left);
    expect(ownerMoveProblems(components, [block.id])).toEqual([]);
    const outside = applyOwnerMoves(
      hook.edit,
      [{ id: block.id, x: -500, y: before.y, size: before.size! }],
      context,
    );
    if (!outside.ok) throw new Error(outside.reasons.join("; "));
    expect(ownerMoveProblems(await componentsOf(hook, outside.edit), [block.id])).toEqual([
      `${block.id}: runs past the safe zone`,
    ]);
  });

  it("has the size range of a text, refuses a block that is none and still refuses a single caption", async () => {
    const context = await contextOf(hook);
    const block = largestBlock(hook);
    expect(ownerSizeRange(hook.edit, block.id, preset)).toEqual([30, 400]);
    const single = hook.edit.tracks.captions[0]!.id;
    expect(applyOwnerMoves(hook.edit, [{ id: single, x: 100, y: 300, size: 50 }], context)).toEqual(
      { ok: false, reasons: [`${single}: not a text component of this version`] },
    );
    // A caption that starts no block is no block.
    const second = block.groups[0]!.captions[1] ?? block.groups[1]!.id;
    const none = `${CAPTION_BLOCK_PREFIX}${second}`;
    expect(applyOwnerMoves(hook.edit, [{ id: none, x: 100, y: 300, size: 50 }], context)).toEqual({
      ok: false,
      reasons: [`${none}: not a caption block of this version`],
    });
    expect(ownerSizeRange(hook.edit, `${CAPTION_BLOCK_PREFIX}nothing`, preset)).toBeNull();
  });

  it("is left out when it changes nothing, and recorded as CAPTION with the engine's box and variant", async () => {
    const context = await contextOf(hook);
    const block = largestBlock(hook);
    const engine = await componentsOf(hook);
    const before = blockOf(engine, block.id);
    const same = { id: block.id, x: before.x, y: before.y, size: before.size! };
    expect(effectiveMoves([same], engine)).toEqual([]);
    const move = { ...same, y: before.y - 80 };
    expect(effectiveMoves([move], engine)).toEqual([move]);
    const applied = applyOwnerMoves(hook.edit, [move], context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const owner = await componentsOf(hook, applied.edit);
    const [record] = ownerMoveRecords({
      ids: [block.id],
      moves: [move],
      engine,
      owner,
      edit: applied.edit,
      headTrack: hook.headTrack,
      preset,
      engineRecord: [
        {
          item: block.groups[0]!.id,
          component: "CAPTION",
          variant: "caption/default",
          start: block.start,
          end: block.end,
          outcome: "placed",
          rule: "zone",
          zone: "caption-line",
          blockers: [],
          reason: "placed",
        },
      ],
      transcript: hook.transcript,
    });
    expect(record).toMatchObject({
      item: block.id,
      component: "CAPTION",
      variant: "caption/default",
      text: before.text,
      moved: true,
      resized: false,
      engine: { x: before.x, y: before.y, size: before.size },
      owner: { x: before.x, y: before.y - 80, size: before.size },
      wrap_width: null,
    });
    expect(record!.context.engine_zone).toBe("caption-line");
    // The others on screen: never the block's own captions, nor a block's box.
    const own = new Set(block.groups.flatMap((group) => group.captions));
    for (const other of record!.context.others) {
      expect(own.has(other.item)).toBe(false);
      expect(other.item.startsWith(CAPTION_BLOCK_PREFIX)).toBe(false);
    }
  });
});
