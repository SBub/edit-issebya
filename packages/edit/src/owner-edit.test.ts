import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import type { PlacedComponent } from "./components.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import {
  applyOwnerMoves,
  effectiveMoves,
  fitInFrame,
  fitInSafeZone,
  isMovable,
  ownerMoveProblems,
  ownerMoveRecords,
  ownerSizeRange,
  ownerWrapOptions,
  parseOwnerMoves,
  settleOwnerMove,
  shownShare,
  withOwnerCutouts,
} from "./owner-edit.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
import { STYLES } from "./variants.ts";
import { type Fixture, FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// Two placed versions: one with the hook, two accents and a big word behind
// the speaker, one with two numbered LIST items as well.
const hook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const lists = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;
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

function byId(components: readonly PlacedComponent[], id: string): PlacedComponent {
  const found = components.find((component) => component.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

describe("the components of a built page", () => {
  it("names each component with its kind, its text and one box for its time on screen", async () => {
    const components = await componentsOf(hook);
    expect(byId(components, "hook")).toMatchObject({
      component: "HOOK",
      text: "Gen Z won't work like you did",
      size: 110,
      x: 135,
      y: 220,
    });
    expect(byId(components, "accent-1")).toMatchObject({ component: "ACCENT", size: 110 });
    expect(byId(components, "big-word-1")).toMatchObject({
      component: "BIGWORD",
      x: 36,
      y: 389,
      size: 198,
      height: 198,
    });
    expect(byId(components, "visual-1")).toMatchObject({ component: "VISUAL", size: null });
    expect(components.filter((component) => component.component === "CAPTION").length).toBe(
      hook.edit.tracks.captions.filter((caption) => caption.hidden_by === undefined).length,
    );
  });

  it("gives a LIST one box around its levels and its key phrase's size", async () => {
    const components = await componentsOf(lists);
    const list = byId(components, "transition-1");
    const { number, lead, key } = lists.edit.tracks.transitions[0]!.levels!;
    expect(list.component).toBe("LIST");
    expect(list.size).toBe(key.size);
    expect(list.x).toBe(Math.min(number!.position.x, lead!.position.x, key.position.x));
    expect(list.y).toBe(number!.position.y);
    // The key phrase is the lowest level: one line or more of its size.
    expect((list.y + list.height - key.position.y) % key.size).toBe(0);
    expect(list.text).toBe(`${number!.text} ${lead!.text} ${key.text}`);
  });

  it("reads a question from its id, whatever draws it", async () => {
    const edit: Edit = {
      ...hook.edit,
      tracks: {
        ...hook.edit.tracks,
        overlays: hook.edit.tracks.overlays.map((item) =>
          item.id === "accent-1" ? { ...item, id: "question-1" } : item,
        ),
        captions: hook.edit.tracks.captions.map((item) =>
          item.hidden_by === "accent-1" ? { ...item, hidden_by: "question-1" } : item,
        ),
      },
    };
    expect(byId(await componentsOf(hook, edit), "question-1").component).toBe("QUESTION");
  });

  it("says which components the owner may move", async () => {
    const components = await componentsOf(lists);
    const movable = components.filter(isMovable).map((component) => component.component);
    expect(new Set(movable)).toEqual(new Set(["ACCENT", "BIGWORD", "LIST", "VISUAL"]));
    expect(isMovable({ component: "CAPTION" })).toBe(false);
    expect(isMovable({ component: "VISUAL" })).toBe(true);
    expect(isMovable({ component: "HOOK" })).toBe(true);
    expect(isMovable({ component: "QUESTION" })).toBe(true);
  });
});

describe("applying the owner's moves", () => {
  it("moves an accent: its box's corner is the move's, its size and words kept", async () => {
    const context = await contextOf(hook);
    const before = byId(await componentsOf(hook), "accent-1");
    const applied = applyOwnerMoves(
      hook.edit,
      [{ id: "accent-1", x: 120, y: 900, size: before.size! }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = byId(await componentsOf(hook, applied.edit), "accent-1");
    expect(after).toMatchObject({ x: 120, y: 900, size: before.size });
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect([after.start, after.end, after.text]).toEqual([before.start, before.end, before.text]);
    const item = applied.edit.tracks.overlays.find((overlay) => overlay.id === "accent-1")!;
    const was = hook.edit.tracks.overlays.find((overlay) => overlay.id === "accent-1")!;
    expect(item).toEqual({ ...was, position: { x: 120, y: 900, align: "left" }, size: was.size });
  });

  it("changes nothing else in the edit", async () => {
    const context = await contextOf(hook);
    const applied = applyOwnerMoves(hook.edit, [{ id: "hook", x: 60, y: 300, size: 80 }], context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const { overlays, ...tracks } = applied.edit.tracks;
    const { overlays: original, ...originalTracks } = hook.edit.tracks;
    expect(tracks).toEqual(originalTracks);
    expect(overlays.filter((item) => item.id !== "hook")).toEqual(
      original.filter((item) => item.id !== "hook"),
    );
    expect({ ...applied.edit, tracks: null }).toEqual({ ...hook.edit, tracks: null });
  });

  it("resizes a text: the size scales the box, the corner stays", async () => {
    const context = await contextOf(hook);
    const before = byId(await componentsOf(hook), "hook");
    const applied = applyOwnerMoves(
      hook.edit,
      [{ id: "hook", x: before.x, y: before.y, size: 55 }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = byId(await componentsOf(hook, applied.edit), "hook");
    expect(after).toMatchObject({ x: before.x, y: before.y, size: 55 });
    // Half the size: half the box (the lines are the same lines).
    expect(after.height).toBe(before.height / 2);
    expect(after.width).toBeCloseTo(before.width / 2, 6);
  });

  it("moves and resizes a big word by its corner and size", async () => {
    const context = await contextOf(hook);
    const applied = applyOwnerMoves(
      hook.edit,
      [{ id: "big-word-1", x: 200, y: 240, size: 120 }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const word = applied.edit.tracks.behind!.find((item) => item.id === "big-word-1")!;
    expect(word).toMatchObject({ position: { x: 200, y: 240 }, size: 120 });
    expect(byId(await componentsOf(hook, applied.edit), "big-word-1")).toMatchObject({
      x: 200,
      y: 240,
      height: 120,
    });
  });

  it("moves a LIST as one box: every level keeps its offset", async () => {
    const context = await contextOf(lists);
    const before = byId(await componentsOf(lists), "transition-1");
    const applied = applyOwnerMoves(
      lists.edit,
      [{ id: "transition-1", x: before.x + 40, y: before.y - 100, size: before.size! }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const was = lists.edit.tracks.transitions[0]!.levels!;
    const now = applied.edit.tracks.transitions[0]!.levels!;
    for (const role of ["number", "lead", "key"] as const) {
      expect(now[role]!.position).toEqual({
        x: was[role]!.position.x + 40,
        y: was[role]!.position.y - 100,
        align: "left",
      });
      expect(now[role]!.size).toBe(was[role]!.size);
      expect(now[role]!.text).toBe(was[role]!.text);
    }
    const after = byId(await componentsOf(lists, applied.edit), "transition-1");
    expect(after).toMatchObject({
      x: before.x + 40,
      y: before.y - 100,
      width: before.width,
      height: before.height,
    });
  });

  it("resizes a LIST about its corner: every level scaled by the key phrase's ratio", async () => {
    const context = await contextOf(lists);
    const before = byId(await componentsOf(lists), "transition-1");
    const applied = applyOwnerMoves(
      lists.edit,
      [{ id: "transition-1", x: before.x, y: before.y, size: 77 }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const was = lists.edit.tracks.transitions[0]!.levels!;
    const now = applied.edit.tracks.transitions[0]!.levels!;
    // The key phrase 110 to 77 (0.7): the number 300 to 210, the lead-in 50 to 35.
    expect([now.number!.size, now.lead!.size, now.key.size]).toEqual([210, 35, 77]);
    expect(now.key.position.y - before.y).toBe(Math.round((was.key.position.y - before.y) * 0.7));
    const after = byId(await componentsOf(lists, applied.edit), "transition-1");
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(Math.abs(after.height - before.height * 0.7)).toBeLessThan(2);
    expect(Math.abs(after.width - before.width * 0.7)).toBeLessThan(2);
  });

  it("rewraps a text to a wrap width: more lines when narrower, one when wider, the size and words kept", async () => {
    const context = await contextOf(hook);
    const before = byId(await componentsOf(hook), "hook");
    const narrow = applyOwnerMoves(
      hook.edit,
      [{ id: "hook", x: before.x, y: before.y, size: 110, width: before.width * 0.6 }],
      context,
    );
    if (!narrow.ok) throw new Error(narrow.reasons.join("; "));
    const item = narrow.edit.tracks.overlays.find((overlay) => overlay.id === "hook")!;
    const after = byId(await componentsOf(hook, narrow.edit), "hook");
    expect(after.size).toBe(110);
    expect(after.text).toBe(before.text);
    expect(after.width).toBeLessThanOrEqual(before.width * 0.6);
    expect(after.height).toBeGreaterThan(before.height);
    expect(after.height % 110).toBe(0);
    expect(item.breaks!.length).toBe(after.height / 110 - 1);

    const wide = applyOwnerMoves(
      narrow.edit,
      [{ id: "hook", x: before.x, y: before.y, size: 110, width: 5000 }],
      context,
    );
    if (!wide.ok) throw new Error(wide.reasons.join("; "));
    expect(wide.edit.tracks.overlays.find((overlay) => overlay.id === "hook")!.breaks).toBe(
      undefined,
    );
    expect(byId(await componentsOf(hook, wide.edit), "hook").height).toBe(110);
  });

  it("rewraps a LIST's lead-in and key phrase to a wrap width and stacks the levels again", async () => {
    const context = await contextOf(lists);
    const before = byId(await componentsOf(lists), "transition-1");
    const width = before.width * 0.5;
    const applied = applyOwnerMoves(
      lists.edit,
      [{ id: "transition-1", x: before.x, y: before.y, size: before.size!, width }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const was = lists.edit.tracks.transitions[0]!.levels!;
    const now = applied.edit.tracks.transitions[0]!.levels!;
    expect([now.number!.size, now.lead!.size, now.key.size]).toEqual([
      was.number!.size,
      was.lead!.size,
      was.key.size,
    ]);
    expect(now.number!.breaks).toEqual(was.number!.breaks);
    const after = byId(await componentsOf(lists, applied.edit), "transition-1");
    expect(after.y).toBe(before.y);
    expect(after.width).toBeLessThan(before.width);
    expect(after.height).toBeGreaterThan(before.height);
    // Stacked top to bottom with the version's gaps: number, lead-in, key phrase.
    expect(now.number!.position.y).toBe(before.y);
    expect(now.lead!.position.y).toBeGreaterThan(now.number!.position.y);
    expect(now.key.position.y).toBeGreaterThan(now.lead!.position.y);
  });

  it("refuses a wrap width on a big word and a wrap width that is no positive number", async () => {
    const context = await contextOf(hook);
    expect(
      applyOwnerMoves(
        hook.edit,
        [
          { id: "big-word-1", x: 36, y: 390, size: 197, width: 400 },
          { id: "hook", x: 135, y: 220, size: 110, width: 0 },
        ],
        context,
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "big-word-1: a big word keeps its lines",
        "hook: its wrap width is not a positive number",
      ],
    });
  });

  it("offers the wrap widths of a text, widest first, each with its box", async () => {
    const context = await contextOf(hook);
    const before = byId(await componentsOf(hook), "hook");
    const options = ownerWrapOptions(hook.edit, "hook", { x: 135, y: 220, size: 110 }, context)!;
    const words = before.text.split(" ").length;
    expect(options.length).toBeGreaterThan(1);
    expect(options.length).toBeLessThanOrEqual(words);
    expect(options[0]!.boxHeight).toBe(110);
    for (const [index, option] of options.entries()) {
      if (index === 0) continue;
      const wider = options[index - 1]!;
      expect(option.width).toBeLessThan(wider.width);
      expect(option.boxHeight).toBeGreaterThan(wider.boxHeight);
      expect(option.boxWidth).toBeLessThanOrEqual(option.width + 1e-6);
    }
    expect(
      ownerWrapOptions(hook.edit, "big-word-1", { x: 36, y: 390, size: 197 }, context),
    ).toBeNull();
    const lists2 = await contextOf(lists);
    const list = byId(await componentsOf(lists), "transition-1");
    expect(
      ownerWrapOptions(lists.edit, "transition-1", { ...list, size: list.size! }, lists2)!.length,
    ).toBeGreaterThan(1);
  });

  it("refuses a caption, a visual, an unknown id, a size out of range and a move made twice", async () => {
    const context = await contextOf(lists);
    const caption = lists.edit.tracks.captions[0]!.id;
    const refused = applyOwnerMoves(
      lists.edit,
      [
        { id: caption, x: 100, y: 300, size: 50 },
        { id: "visual-1", x: 100, y: 300, size: 50 },
        { id: "nothing", x: 100, y: 300, size: 50 },
        { id: "accent-1", x: 100, y: 300, size: 20 },
        { id: "accent-2", x: 100, y: 300, size: 401 },
        { id: "big-word-1", x: 100, y: 300, size: 100 },
        { id: "big-word-1", x: 100, y: 300, size: 100 },
      ],
      context,
    );
    expect(refused).toEqual({
      ok: false,
      reasons: [
        `${caption}: not a text component of this version`,
        "visual-1: a visual moves as a box",
        "nothing: not a text component of this version",
        "accent-1: size 20 is outside 30 to 400 px",
        "accent-2: size 401 is outside 30 to 400 px",
        "big-word-1: moved twice",
      ],
    });
  });

  it("moves and scales a VISUAL's box, its height following its picture's aspect ratio", async () => {
    const context = await contextOf(hook);
    // visual-1 is 300 by 383: its picture is 1170 by 1494.
    const moved = applyOwnerMoves(
      hook.edit,
      [{ id: "visual-1", kind: "box", x: 600.4, y: 700, width: 300 }],
      context,
    );
    if (!moved.ok) throw new Error(moved.reasons.join("; "));
    const visual = (edit: Edit) => edit.tracks.behind!.find((item) => item.id === "visual-1")!;
    expect(visual(moved.edit)).toMatchObject({ box: { x: 600, y: 700, width: 300, height: 383 } });
    const scaled = applyOwnerMoves(
      hook.edit,
      [{ id: "visual-1", kind: "box", x: 75, y: 1047, width: 150 }],
      context,
    );
    if (!scaled.ok) throw new Error(scaled.reasons.join("; "));
    expect(visual(scaled.edit)).toMatchObject({
      box: { x: 75, y: 1047, width: 150, height: Math.round((150 * 1494) / 1170) },
    });
    // Nothing else changed: the picture, the time, the other items.
    expect({ ...visual(scaled.edit), box: null }).toEqual({ ...visual(hook.edit), box: null });
    expect(scaled.edit.tracks.overlays).toEqual(hook.edit.tracks.overlays);
    // The builder draws it there.
    expect(byId(await componentsOf(hook, scaled.edit), "visual-1")).toMatchObject({
      x: 75,
      y: 1047,
      width: 150,
      height: 192,
    });
  });

  it("refuses a box move on a text, a VISUAL narrower than 100 px and a VISUAL moved twice", async () => {
    const context = await contextOf(hook);
    expect(
      applyOwnerMoves(
        hook.edit,
        [
          { id: "hook", kind: "box", x: 100, y: 300, width: 300 },
          { id: "visual-1", kind: "box", x: 100, y: 300, width: 99 },
          { id: "visual-1", kind: "box", x: 100, y: 300, width: 200 },
        ],
        context,
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "hook: not a visual of this version",
        "visual-1: width 99 is outside 100 to 1080 px",
        "visual-1: moved twice",
      ],
    });
  });

  it("keeps a LIST's smallest level at 30 px or more", async () => {
    // The key phrase 110 beside a lead-in of 50 and a number of 300: the lead-in
    // reaches 30 at a key of 66, the number 400 at a key of 146.
    expect(ownerSizeRange(lists.edit, "transition-1", preset)).toEqual([66, 146]);
    expect(ownerSizeRange(lists.edit, "accent-1", preset)).toEqual([30, 400]);
    expect(ownerSizeRange(lists.edit, "big-word-1", preset)).toEqual([30, 1920]);
    expect(ownerSizeRange(lists.edit, "visual-1", preset)).toBeNull();
  });
});

describe("the safe zone, the owner's one hard rule", () => {
  const { box: safe, notch } = SAFE_ZONE;

  it("leaves a box inside the safe zone where it is", () => {
    expect(fitInSafeZone({ x: 200, y: 400, width: 300, height: 110 })).toEqual({ x: 200, y: 400 });
  });

  it("brings a box past an edge back to that edge", () => {
    expect(fitInSafeZone({ x: -50, y: 10, width: 300, height: 110 })).toEqual({
      x: safe.left,
      y: safe.top,
    });
    expect(fitInSafeZone({ x: 900, y: 1000, width: 300, height: 110 })).toEqual({
      x: safe.right - 300,
      y: 1000,
    });
    expect(fitInSafeZone({ x: 100, y: 1900, width: 300, height: 110 })).toEqual({
      x: 100,
      y: safe.bottom - 110,
    });
  });

  it("moves a box out of the buttons' notch the shorter way", () => {
    // 10 px into the column, far below its top: left.
    expect(fitInSafeZone({ x: notch.left - 290, y: 1300, width: 300, height: 110 })).toEqual({
      x: notch.left - 300,
      y: 1300,
    });
    // 10 px below the column's top, far into it: up.
    expect(
      fitInSafeZone({ x: notch.left - 100, y: notch.top - 100, width: 200, height: 110 }),
    ).toEqual({ x: notch.left - 100, y: notch.top - 110 });
  });

  it("has no place for a box larger than the safe zone", () => {
    expect(fitInSafeZone({ x: 0, y: 300, width: 1011, height: 110 })).toBeNull();
    expect(fitInSafeZone({ x: 100, y: 0, width: 300, height: 1251 })).toBeNull();
  });

  it("names a moved component that leaves the safe zone or reaches the notch", async () => {
    const context = await contextOf(hook);
    const second = byId(await componentsOf(hook), "accent-2");
    const moved = applyOwnerMoves(
      hook.edit,
      [
        { id: "accent-1", x: 0, y: 900, size: 110 },
        // 10 px into the button column, below its top.
        { id: "accent-2", x: Math.floor(notch.left - second.width + 10), y: 1300, size: 110 },
        { id: "hook", x: 100, y: 600, size: 80 },
      ],
      context,
    );
    if (!moved.ok) throw new Error(moved.reasons.join("; "));
    const components = await componentsOf(hook, moved.edit);
    expect(ownerMoveProblems(components, ["accent-1", "accent-2", "hook", "gone"])).toEqual([
      "accent-1: runs past the safe zone",
      "accent-2: runs into the platform button column",
      "gone: not on screen in this version",
    ]);
  });

  it("settles a drag past the edge at the edge, at whole pixels", async () => {
    const context = await contextOf(hook);
    const settled = settleOwnerMove(
      hook.edit,
      { id: "accent-1", x: -200.4, y: 3000, size: 110 },
      context,
    );
    if (!settled.ok) throw new Error(settled.reasons.join("; "));
    expect(settled.move).toEqual({ id: "accent-1", x: safe.left, y: safe.bottom - 110, size: 110 });
    const components = await componentsOf(hook, settled.edit);
    expect(ownerMoveProblems(components, ["accent-1"])).toEqual([]);
  });

  it("settles a resize too large for the safe zone at the largest size that fits", async () => {
    const context = await contextOf(hook);
    const before = byId(await componentsOf(hook), "big-word-1");
    const settled = settleOwnerMove(
      hook.edit,
      { id: "big-word-1", x: before.x, y: before.y, size: 1500 },
      context,
    );
    if (!settled.ok) throw new Error(settled.reasons.join("; "));
    const after = byId(await componentsOf(hook, settled.edit), "big-word-1");
    expect(after.width).toBeLessThanOrEqual(safe.right - safe.left);
    expect(after.width).toBeGreaterThan((safe.right - safe.left) * 0.98);
    expect(ownerMoveProblems([after], ["big-word-1"])).toEqual([]);
    expect(settled.move).toMatchObject({ size: after.size });
  });

  it("settles a size under the floor at 30 px, and leaves a legal move as it is", async () => {
    const context = await contextOf(hook);
    const small = settleOwnerMove(hook.edit, { id: "hook", x: 300, y: 500, size: 4 }, context);
    if (!small.ok) throw new Error(small.reasons.join("; "));
    expect(small.move).toEqual({ id: "hook", x: 300, y: 500, size: 30 });
    const legal = settleOwnerMove(hook.edit, { id: "hook", x: 300, y: 500, size: 90 }, context);
    if (!legal.ok) throw new Error(legal.reasons.join("; "));
    expect(legal.move).toEqual({ id: "hook", x: 300, y: 500, size: 90 });
  });

  it("settles a wrap width no wider than the safe zone, and keeps the lines when it shrinks the size", async () => {
    const context = await contextOf(hook);
    const settled = settleOwnerMove(
      hook.edit,
      { id: "hook", x: 135, y: 220, size: 110, width: 4000 },
      context,
    );
    if (!settled.ok) throw new Error(settled.reasons.join("; "));
    expect(settled.move.width).toBe(safe.right - safe.left);
    const after = byId(await componentsOf(hook, settled.edit), "hook");
    expect(ownerMoveProblems([after], ["hook"])).toEqual([]);
  });

  it("lets a VISUAL past the safe zone, keeping a fifth of it inside the frame", async () => {
    const context = await contextOf(hook);
    // Into the bottom right corner, over the platform buttons' notch: allowed.
    const corner = settleOwnerMove(
      hook.edit,
      { id: "visual-1", kind: "box", x: 900.4, y: 1700, width: 300 },
      context,
    );
    if (!corner.ok) throw new Error(corner.reasons.join("; "));
    expect(corner.move).toEqual({ id: "visual-1", kind: "box", x: 900, y: 1700, width: 300 });
    const placed = byId(await componentsOf(hook, corner.edit), "visual-1");
    expect(ownerMoveProblems([placed], ["visual-1"])).toEqual([]);
    // Dragged far off the frame: brought back the least so a fifth shows.
    const past = settleOwnerMove(
      hook.edit,
      { id: "visual-1", kind: "box", x: -5000, y: 5000, width: 300 },
      context,
    );
    if (!past.ok) throw new Error(past.reasons.join("; "));
    const after = byId(await componentsOf(hook, past.edit), "visual-1");
    const share = shownShare(after, preset.frame);
    expect(share).toBeGreaterThanOrEqual(0.2);
    expect(share).toBeLessThan(0.21);
    expect(after.x).toBeLessThan(0);
    expect(after.y + after.height).toBeGreaterThan(preset.frame.height);
    expect(ownerMoveProblems([after], ["visual-1"])).toEqual([]);
    // Wider than the frame: the frame's width; its aspect ratio kept.
    const huge = settleOwnerMove(
      hook.edit,
      { id: "visual-1", kind: "box", x: 75, y: 300, width: 5000 },
      context,
    );
    if (!huge.ok) throw new Error(huge.reasons.join("; "));
    const wide = byId(await componentsOf(hook, huge.edit), "visual-1");
    expect(wide.width).toBe(preset.frame.width);
    expect(Math.abs(wide.height / wide.width - 1494 / 1170)).toBeLessThan(0.01);
    // A VISUAL narrower than its floor is brought up to it.
    const tiny = settleOwnerMove(
      hook.edit,
      { id: "visual-1", kind: "box", x: 300, y: 600, width: 20 },
      context,
    );
    if (!tiny.ok) throw new Error(tiny.reasons.join("; "));
    expect(tiny.move).toMatchObject({ x: 300, y: 600, width: 100 });
  });

  it("finds the nearest place that keeps a fifth of a rectangle inside the frame", () => {
    const frame = { width: 1080, height: 1920 };
    // Already a fifth or more inside: unchanged.
    expect(fitInFrame({ x: -200, y: 100, width: 300, height: 300 }, frame)).toEqual({
      x: -200,
      y: 100,
    });
    // Off the left edge only: moved right until a fifth of its width shows.
    expect(fitInFrame({ x: -500, y: 100, width: 300, height: 300 }, frame)).toEqual({
      x: -240,
      y: 100,
    });
    // Off a corner: the rectangle holds a fifth after the move.
    const at = fitInFrame({ x: 2000, y: 3000, width: 300, height: 300 }, frame);
    expect(shownShare({ ...at, width: 300, height: 300 }, frame)).toBeCloseTo(0.2, 6);
    expect(at.x).toBeGreaterThan(frame.width - 300);
    expect(at.y).toBeGreaterThan(frame.height - 300);
  });

  it("refuses to settle a caption", async () => {
    const context = await contextOf(hook);
    const id = hook.edit.tracks.captions[0]!.id;
    expect(settleOwnerMove(hook.edit, { id, x: 300, y: 500, size: 50 }, context)).toEqual({
      ok: false,
      reasons: [`${id}: not a text component of this version`],
    });
  });
});

describe("the moves of one save", () => {
  it("parses a list of moves and refuses anything else", () => {
    expect(parseOwnerMoves([{ id: "accent-1", x: 10.5, y: 20, size: 90, extra: true }])).toEqual([
      { id: "accent-1", x: 10.5, y: 20, size: 90 },
    ]);
    expect(parseOwnerMoves([{ id: "hook", x: 10, y: 20, size: 90, width: 412.5 }])).toEqual([
      { id: "hook", x: 10, y: 20, size: 90, width: 412.5 },
    ]);
    expect(
      parseOwnerMoves([{ id: "visual-1", kind: "box", x: 10, y: 20.5, width: 250.5, extra: 1 }]),
    ).toEqual([{ id: "visual-1", kind: "box", x: 10, y: 20.5, width: 250.5 }]);
    for (const bad of [
      null,
      {},
      [],
      [{ id: "a", x: 1, y: 2 }],
      [{ id: "a", x: "1", y: 2, size: 3 }],
      [{ id: "a", x: 1, y: 2, size: 3.5 }],
      [{ id: "a", x: Number.NaN, y: 2, size: 3 }],
      [{ id: "", x: 1, y: 2, size: 3 }],
      [
        { id: "a", x: 1, y: 2, size: 3 },
        { id: "a", x: 1, y: 2, size: 3 },
      ],
      Array.from({ length: 201 }, (_, index) => ({ id: `a${index}`, x: 1, y: 2, size: 30 })),
      [{ id: "a", x: 1, y: 2, size: 30, width: 0 }],
      [{ id: "a", x: 1, y: 2, size: 30, width: "400" }],
      [{ id: "a", x: 1, y: 2, size: 30, width: Number.POSITIVE_INFINITY }],
      [{ id: "a", kind: "box", x: 1, y: 2 }],
      [{ id: "a", kind: "box", x: 1, y: 2, width: 0 }],
      [{ id: "a", kind: "box", x: 1, y: 2, width: 300, size: 30 }],
      [{ id: "a", kind: "circle", x: 1, y: 2, size: 30 }],
    ]) {
      expect(parseOwnerMoves(bad)).toBeNull();
    }
  });

  it("leaves out a move that changes nothing", async () => {
    const components = await componentsOf(hook);
    const accent = byId(components, "accent-1");
    expect(
      effectiveMoves(
        [
          { id: "accent-1", x: accent.x, y: accent.y, size: accent.size! },
          { id: "hook", x: 300, y: 500, size: 110 },
        ],
        components,
      ),
    ).toEqual([{ id: "hook", x: 300, y: 500, size: 110 }]);
  });

  it("leaves out a VISUAL's move that changes nothing", async () => {
    const components = await componentsOf(hook);
    const still = { id: "visual-1", kind: "box" as const, x: 75, y: 1047, width: 300 };
    const moved = { ...still, x: 90 };
    const scaled = { ...still, width: 200 };
    expect(effectiveMoves([still, moved], components)).toEqual([moved]);
    expect(effectiveMoves([scaled], components)).toEqual([scaled]);
  });

  it("keeps a move with a wrap width, and with the draft's boxes leaves out a rewrap back to the version's lines", async () => {
    const context = await contextOf(hook);
    const components = await componentsOf(hook);
    const hookBox = byId(components, "hook");
    const back = { id: "hook", x: hookBox.x, y: hookBox.y, size: 110, width: 5000 };
    expect(effectiveMoves([back], components)).toEqual([back]);
    const applied = applyOwnerMoves(hook.edit, [back], context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const draft = await componentsOf(hook, applied.edit);
    const sameLines =
      byId(draft, "hook").height === hookBox.height &&
      Math.abs(byId(draft, "hook").width - hookBox.width) < 0.5;
    expect(effectiveMoves([back], components, draft)).toEqual(sameLines ? [] : [back]);
    const narrow = { ...back, width: hookBox.width * 0.5 };
    const rewrapped = applyOwnerMoves(hook.edit, [narrow], context);
    if (!rewrapped.ok) throw new Error(rewrapped.reasons.join("; "));
    expect(effectiveMoves([narrow], components, await componentsOf(hook, rewrapped.edit))).toEqual([
      narrow,
    ]);
  });
});

describe("a moved big word's cut-out", () => {
  it("needs no cut-out above the head and needs one on it", async () => {
    const context = await contextOf(hook);
    const up = applyOwnerMoves(hook.edit, [{ id: "big-word-1", x: 36, y: 220, size: 60 }], context);
    if (!up.ok) throw new Error(up.reasons.join("; "));
    const above = withOwnerCutouts(up.edit, ["big-word-1"], context);
    expect(above.tracks.behind!.find((item) => item.id === "big-word-1")).toMatchObject({
      cutout: false,
    });
    const down = applyOwnerMoves(above, [{ id: "big-word-1", x: 36, y: 700, size: 197 }], context);
    if (!down.ok) throw new Error(down.reasons.join("; "));
    const onHead = withOwnerCutouts(down.edit, ["big-word-1"], context);
    expect(onHead.tracks.behind!.find((item) => item.id === "big-word-1")).toMatchObject({
      cutout: true,
    });
  });

  it("leaves a word the owner did not move as it is", async () => {
    const context = await contextOf(hook);
    expect(withOwnerCutouts(hook.edit, ["accent-1"], context)).toBe(hook.edit);
  });
});

describe("the learning records of a save", () => {
  it("records each moved component: the engine's box, the owner's, the head and the others on screen", async () => {
    const context = await contextOf(hook);
    const engine = await componentsOf(hook);
    const applied = applyOwnerMoves(
      hook.edit,
      [
        { id: "accent-1", x: 120, y: 900, size: 110 },
        { id: "hook", x: 135, y: 220, size: 80 },
      ],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const owner = await componentsOf(hook, applied.edit);
    const records = ownerMoveRecords({
      ids: ["accent-1", "hook", "accent-2"],
      engine,
      owner,
      edit: applied.edit,
      headTrack: hook.headTrack,
      preset,
      engineRecord: [
        {
          item: "accent-1",
          component: "ACCENT",
          variant: "accent/above-head",
          start: 0,
          end: 1,
          rule: "zone",
          outcome: "placed",
          blockers: [],
          zone: "above-head",
          reason: "",
        },
      ],
    });
    // accent-2 was named but is where the engine placed it: no record.
    expect(records.map((record) => record.item)).toEqual(["accent-1", "hook"]);
    const [accent, written] = records as [(typeof records)[number], (typeof records)[number]];
    const was = byId(engine, "accent-1");
    expect(accent).toMatchObject({
      component: "ACCENT",
      variant: "accent/above-head",
      text: was.text,
      start: was.start,
      end: was.end,
      engine: { x: was.x, y: was.y, width: was.width, height: was.height, size: 110 },
      owner: { x: 120, y: 900, width: was.width, height: was.height, size: 110 },
      moved: true,
      resized: false,
    });
    expect(accent.context.frame).toEqual({ width: 1080, height: 1920 });
    expect(accent.context.font_pair).toBe("classic");
    expect(accent.context.engine_zone).toBe("above-head");
    expect(accent.context.head).toMatchObject({
      left: expect.any(Number) as number,
      top: expect.any(Number) as number,
    });
    // Everything else on screen in its time, never itself.
    const others = accent.context.others;
    expect(others.some((other) => other.item === "accent-1")).toBe(false);
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) {
      expect(other.start).toBeLessThan(accent.end);
      expect(other.end).toBeGreaterThan(accent.start);
    }
    expect(written).toMatchObject({ component: "HOOK", moved: false, resized: true });
    expect(written.variant).toBeNull();
    expect(written.context.engine_zone).toBeNull();
    expect(written.owner.size).toBe(80);
    expect(written.engine!.size).toBe(110);
    expect(accent.wrap_width).toBeNull();
  });

  it("records a rewrap as a resize, with the wrap width the owner set", async () => {
    const context = await contextOf(hook);
    const engine = await componentsOf(hook);
    const was = byId(engine, "hook");
    const moves = [{ id: "hook", x: was.x, y: was.y, size: 110, width: was.width * 0.6 }];
    const applied = applyOwnerMoves(hook.edit, moves, context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const [record] = ownerMoveRecords({
      ids: ["hook"],
      moves,
      engine,
      owner: await componentsOf(hook, applied.edit),
      edit: applied.edit,
      headTrack: hook.headTrack,
      preset,
    });
    expect(record).toMatchObject({ moved: false, resized: true, wrap_width: was.width * 0.6 });
    expect(record!.owner.size).toBe(110);
    expect(record!.owner.height).toBeGreaterThan(record!.engine!.height);
  });

  it("records a VISUAL moved and scaled: its boxes, no size and no wrap width", async () => {
    const context = await contextOf(hook);
    const engine = await componentsOf(hook);
    const moves = [{ id: "visual-1", kind: "box" as const, x: 600, y: 700, width: 200 }];
    const applied = applyOwnerMoves(hook.edit, moves, context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const [record] = ownerMoveRecords({
      ids: ["visual-1"],
      moves,
      engine,
      owner: await componentsOf(hook, applied.edit),
      edit: applied.edit,
      headTrack: hook.headTrack,
      preset,
    });
    expect(record).toMatchObject({
      item: "visual-1",
      component: "VISUAL",
      engine: { x: 75, y: 1047, width: 300, height: 383, size: null },
      owner: { x: 600, y: 700, width: 200, height: 255, size: null },
      moved: true,
      resized: true,
      wrap_width: null,
    });
  });

  it("marks another component the owner moved earlier", async () => {
    const context = await contextOf(hook);
    const engine = await componentsOf(hook);
    const applied = applyOwnerMoves(
      hook.edit,
      [
        { id: "hook", x: 135, y: 400, size: 110 },
        { id: "big-word-1", x: 36, y: 800, size: 197 },
      ],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const owner = await componentsOf(hook, applied.edit);
    const [record] = ownerMoveRecords({
      ids: ["hook"],
      engine,
      owner,
      edit: applied.edit,
      headTrack: hook.headTrack,
      preset,
    });
    const hookSpan = byId(owner, "hook");
    const word = byId(owner, "big-word-1");
    const together = word.start < hookSpan.end && hookSpan.start < word.end;
    const seen = record!.context.others.find((other) => other.item === "big-word-1");
    expect(seen !== undefined).toBe(together);
    if (seen) expect(seen.moved_by_owner).toBe(true);
    expect(
      record!.context.others
        .filter((other) => other.component === "CAPTION")
        .every((other) => !other.moved_by_owner),
    ).toBe(true);
  });
});

describe("a VISUAL turned by the owner", () => {
  const visual = (edit: Edit) => {
    const item = edit.tracks.behind!.find((entry) => entry.id === "visual-1");
    if (item?.kind !== "visual") throw new Error("no visual-1");
    return item;
  };

  it("turns the card about its centre in whole degrees, its box kept, and the builder draws the turn", async () => {
    const context = await contextOf(hook);
    const turned = applyOwnerMoves(
      hook.edit,
      [{ id: "visual-1", kind: "box", x: 400, y: 700, width: 300, rotation: -350 }],
      context,
    );
    if (!turned.ok) throw new Error(turned.reasons.join("; "));
    expect(visual(turned.edit)).toMatchObject({
      box: { x: 400, y: 700, width: 300, height: 383 },
      rotation: 10,
    });
    const built = build(
      turned.edit,
      context.transcript,
      context.headTrack,
      preset,
      context.measurer,
    );
    expect(byId(built.components, "visual-1")).toMatchObject({
      x: 400,
      y: 700,
      width: 300,
      height: 383,
      rotation: 10,
    });
    // The `rotate` property about the box's centre, never `transform`.
    const element = built.html.match(/<div id="visual-1"[^>]*>/)![0];
    expect(element).toContain("rotate: 10deg");
    expect(element).not.toContain("transform");
    // -190 is 170; a move with no turn keeps the card's own; 0 is upright again.
    const back = applyOwnerMoves(
      turned.edit,
      [{ id: "visual-1", kind: "box", x: 400, y: 700, width: 300, rotation: -190 }],
      context,
    );
    if (!back.ok) throw new Error(back.reasons.join("; "));
    expect(visual(back.edit).rotation).toBe(170);
    const kept = applyOwnerMoves(
      turned.edit,
      [{ id: "visual-1", kind: "box", x: 450, y: 700, width: 300 }],
      context,
    );
    if (!kept.ok) throw new Error(kept.reasons.join("; "));
    expect(visual(kept.edit).rotation).toBe(10);
    const upright = applyOwnerMoves(
      turned.edit,
      [{ id: "visual-1", kind: "box", x: 400, y: 700, width: 300, rotation: 0 }],
      context,
    );
    if (!upright.ok) throw new Error(upright.reasons.join("; "));
    expect("rotation" in visual(upright.edit)).toBe(false);
    expect(
      build(upright.edit, context.transcript, context.headTrack, preset, context.measurer).html,
    ).not.toContain("rotate:");
  });

  it("refuses a turn that is not whole degrees, and a turn on a text", async () => {
    const context = await contextOf(hook);
    expect(
      applyOwnerMoves(
        hook.edit,
        [{ id: "visual-1", kind: "box", x: 400, y: 700, width: 300, rotation: 12.5 }],
        context,
      ),
    ).toEqual({
      ok: false,
      reasons: ["visual-1: its turn is not whole degrees from -360 to 360"],
    });
    expect(parseOwnerMoves([{ id: "hook", x: 1, y: 2, size: 80, rotation: 10 }])).toBeNull();
    expect(
      parseOwnerMoves([{ id: "visual-1", kind: "box", x: 1, y: 2, width: 200, rotation: 1.5 }]),
    ).toBeNull();
    expect(
      parseOwnerMoves([{ id: "visual-1", kind: "box", x: 1, y: 2, width: 200, rotation: 361 }]),
    ).toBeNull();
    expect(
      parseOwnerMoves([{ id: "visual-1", kind: "box", x: 1, y: 2, width: 200, rotation: -45 }]),
    ).toEqual([{ id: "visual-1", kind: "box", x: 1, y: 2, width: 200, rotation: -45 }]);
  });

  it("reads a turned card's place in the frame from the upright rectangle around it", async () => {
    const context = await contextOf(hook);
    // Upright with a fifth of its width inside the left edge it holds; turned
    // 45 degrees the rectangle around it is wider, and less of it is inside.
    const at = { id: "visual-1", kind: "box" as const, x: -240, y: 700, width: 300 };
    const upright = applyOwnerMoves(hook.edit, [at], context);
    const turned = applyOwnerMoves(hook.edit, [{ ...at, x: -330, rotation: 45 }], context);
    if (!upright.ok || !turned.ok) throw new Error("not applied");
    expect(ownerMoveProblems(await componentsOf(hook, upright.edit), ["visual-1"])).toEqual([]);
    expect(ownerMoveProblems(await componentsOf(hook, turned.edit), ["visual-1"])).toEqual([
      "visual-1: less than a fifth of it is inside the frame",
    ]);
  });

  it("settles a turned card so a fifth of the rectangle around it stays in the frame, the turn kept", async () => {
    const context = await contextOf(hook);
    const past = settleOwnerMove(
      hook.edit,
      { id: "visual-1", kind: "box", x: -330, y: 700, width: 300, rotation: 45 },
      context,
    );
    if (!past.ok) throw new Error(past.reasons.join("; "));
    expect(past.move).toMatchObject({ kind: "box", width: 300, rotation: 45 });
    expect(past.move.x).toBeGreaterThan(-330);
    expect(past.move.y).toBe(700);
    const after = byId(await componentsOf(hook, past.edit), "visual-1");
    expect(after.rotation).toBe(45);
    expect(ownerMoveProblems([after], ["visual-1"])).toEqual([]);
    expect(Number.isInteger(after.x) && Number.isInteger(after.y)).toBe(true);
    // Inside the frame but past the safe zone, turned: left where it is.
    const free = settleOwnerMove(
      hook.edit,
      { id: "visual-1", kind: "box", x: 10, y: 700, width: 300, rotation: 30 },
      context,
    );
    if (!free.ok) throw new Error(free.reasons.join("; "));
    expect(free.move).toMatchObject({ x: 10, y: 700, width: 300, rotation: 30 });
    // Any angle is brought to whole degrees from -179 to 180.
    const odd = settleOwnerMove(
      hook.edit,
      { id: "visual-1", kind: "box", x: 400, y: 700, width: 300, rotation: -180 },
      context,
    );
    if (!odd.ok) throw new Error(odd.reasons.join("; "));
    expect(odd.move).toMatchObject({ rotation: 180 });
  });

  it("counts a turn alone as a change, and leaves out a turn back to the card's own", async () => {
    const context = await contextOf(hook);
    const components = await componentsOf(hook);
    const still = { id: "visual-1", kind: "box" as const, x: 75, y: 1047, width: 300 };
    const turned = { ...still, rotation: 15 };
    expect(effectiveMoves([turned], components)).toEqual([turned]);
    expect(effectiveMoves([{ ...still, rotation: 360 }], components)).toEqual([]);
    const applied = applyOwnerMoves(hook.edit, [turned], context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = await componentsOf(hook, applied.edit);
    expect(effectiveMoves([turned], components, after)).toEqual([turned]);
    expect(effectiveMoves([{ ...still, rotation: 0 }], components, components)).toEqual([]);
  });

  it("records a turn alone: the engine's turn 0 and the owner's, rotated, not moved or resized", async () => {
    const context = await contextOf(hook);
    const engine = await componentsOf(hook);
    const moves = [
      { id: "visual-1", kind: "box" as const, x: 75, y: 1047, width: 300, rotation: -20 },
    ];
    const applied = applyOwnerMoves(hook.edit, moves, context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const [record] = ownerMoveRecords({
      ids: ["visual-1"],
      moves,
      engine,
      owner: await componentsOf(hook, applied.edit),
      edit: applied.edit,
      headTrack: hook.headTrack,
      preset,
    });
    expect(record).toMatchObject({
      item: "visual-1",
      component: "VISUAL",
      engine: { x: 75, y: 1047, width: 300, height: 383, size: null },
      owner: { x: 75, y: 1047, width: 300, height: 383, size: null },
      moved: false,
      resized: false,
      rotated: true,
      engine_rotation: 0,
      owner_rotation: -20,
      wrap_width: null,
    });
    // A text's record says no turn.
    const hookMoves = [{ id: "hook", x: 135, y: 400, size: 110 }];
    const hookApplied = applyOwnerMoves(applied.edit, hookMoves, context);
    if (!hookApplied.ok) throw new Error(hookApplied.reasons.join("; "));
    const [hookRecord] = ownerMoveRecords({
      ids: ["hook"],
      moves: hookMoves,
      engine,
      owner: await componentsOf(hook, hookApplied.edit),
      edit: hookApplied.edit,
      headTrack: hook.headTrack,
      preset,
    });
    expect(hookRecord).toMatchObject({ rotated: false, engine_rotation: 0, owner_rotation: 0 });
    const card = hookRecord!.context.others.find((other) => other.item === "visual-1");
    if (card) expect(card).toMatchObject({ rotation: -20, moved_by_owner: true });
  });
});

describe("a QUESTION moved and re-wrapped by the owner", () => {
  // The hook fixture with its first accent made a QUESTION over four words
  // ("disrupted the way we", w29 to w32): an accent overlay with a `question-`
  // id, drawn word by word with a question mark.
  const asked: Edit = {
    ...hook.edit,
    tracks: {
      ...hook.edit.tracks,
      overlays: hook.edit.tracks.overlays.map((item) =>
        item.id === "accent-1"
          ? {
              ...item,
              id: "question-1",
              words: ["w29", "w30", "w31", "w32"],
              end: { word: "w32", edge: "end" as const },
            }
          : item,
      ),
      captions: hook.edit.tracks.captions.map((item) =>
        item.hidden_by === "accent-1" ? { ...item, hidden_by: "question-1" } : item,
      ),
    },
  };
  const ID = "question-1";

  // The question's words on the built page, line by line: each its own
  // element (`question-1_wK`), lines split by `<br />`.
  async function drawnLines(edit: Edit): Promise<string[][]> {
    const context = await contextOf(hook);
    const { html } = build(edit, context.transcript, context.headTrack, preset, context.measurer);
    const element = new RegExp(`<span id="${ID}" class="text[^"]*" style="[^"]*">(.*?)</span>\\n`);
    const inner = element.exec(html)![1]!;
    return inner
      .split("<br />")
      .map((line) => [...line.matchAll(/<span id="question-1_w(\d+)" class="q">([^<]*)<\/span>/g)])
      .map((line) => line.map((match) => `${match[1]}:${match[2]}`));
  }

  it("is one box holding its question mark, measured as drawn", async () => {
    const context = await contextOf(hook);
    const question = byId(await componentsOf(hook, asked), ID);
    expect(question.component).toBe("QUESTION");
    expect(question.text.endsWith("?")).toBe(true);
    expect(question.width).toBeCloseTo(
      context.measurer.width(STYLES.accent.font, question.size!, question.text),
      6,
    );
  });

  it("moves and resizes by its corner, its words, its mark and its reveal kept", async () => {
    const context = await contextOf(hook);
    const before = byId(await componentsOf(hook, asked), ID);
    const applied = applyOwnerMoves(asked, [{ id: ID, x: 100, y: 1000, size: 80 }], context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = byId(await componentsOf(hook, applied.edit), ID);
    expect(after).toMatchObject({ x: 100, y: 1000, size: 80, text: before.text });
    expect([after.start, after.end]).toEqual([before.start, before.end]);
    const words = before.text.split(" ");
    expect((await drawnLines(applied.edit)).flat()).toEqual(
      words.map((word, index) => `${index + 1}:${word}`),
    );
  });

  it("is re-wrapped on its text with the mark: every option's box within its width, every line word by word", async () => {
    const context = await contextOf(hook);
    const before = byId(await componentsOf(hook, asked), ID);
    const options = ownerWrapOptions(asked, ID, { ...before, size: before.size! }, context)!;
    expect(options.length).toBeGreaterThan(1);
    // The widths are the drawn text's, the question mark included.
    for (const option of options) expect(option.boxWidth).toBeLessThanOrEqual(option.width + 1e-6);
    expect(options[0]!.width).toBeCloseTo(before.width, 6);

    const narrowest = options.at(-1)!;
    const applied = applyOwnerMoves(
      asked,
      [{ id: ID, x: before.x, y: before.y, size: before.size!, width: narrowest.width }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const after = byId(await componentsOf(hook, applied.edit), ID);
    expect(after.text).toBe(before.text);
    expect(after.height).toBe(narrowest.boxHeight);
    const lines = await drawnLines(applied.edit);
    expect(lines.length).toBe(after.height / before.size!);
    // Every word its own element, numbered in order across the lines, the
    // question mark on the last word only.
    const words = before.text.split(" ");
    expect(lines.flat()).toEqual(words.map((word, index) => `${index + 1}:${word}`));
    expect(lines.flat().filter((word) => word.includes("?"))).toEqual([
      `${words.length}:${words.at(-1)}`,
    ]);
    // Each word still cuts in at its own moment.
    const { html } = build(
      applied.edit,
      context.transcript,
      context.headTrack,
      preset,
      context.measurer,
    );
    for (const index of words.keys()) {
      expect(html).toContain(`tl.fromTo("#question-1_w${index + 1}", { opacity: 0 }`);
    }
    // Settled where the drag left it, the lines the same.
    const settled = settleOwnerMove(
      asked,
      { id: ID, x: before.x, y: before.y, size: before.size!, width: narrowest.width },
      context,
    );
    if (!settled.ok) throw new Error(settled.reasons.join("; "));
    expect(await drawnLines(settled.edit)).toEqual(lines);
  });

  it("is recorded as a QUESTION with its variant, its text with the mark and its wrap width", async () => {
    const context = await contextOf(hook);
    const engine = await componentsOf(hook, asked);
    const was = byId(engine, ID);
    const moves = [{ id: ID, x: 100, y: 1000, size: was.size!, width: was.width * 0.6 }];
    const applied = applyOwnerMoves(asked, moves, context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const [record] = ownerMoveRecords({
      ids: [ID],
      moves,
      engine,
      owner: await componentsOf(hook, applied.edit),
      edit: applied.edit,
      headTrack: hook.headTrack,
      preset,
      engineRecord: [
        {
          item: ID,
          component: "QUESTION",
          variant: "question/word-by-word",
          start: was.start,
          end: was.end,
          rule: "zone",
          outcome: "placed",
          blockers: [],
          zone: "above-head",
          reason: "",
        },
      ],
    });
    expect(record).toMatchObject({
      item: ID,
      component: "QUESTION",
      variant: "question/word-by-word",
      text: was.text,
      moved: true,
      resized: true,
      wrap_width: was.width * 0.6,
    });
    expect(record!.text.endsWith("?")).toBe(true);
    expect(record!.owner.height).toBeGreaterThan(record!.engine!.height);
  });
});

describe("a VISUAL's picture swapped for a library photo", () => {
  const PHOTO = {
    id: "11111111-2222-4333-8444-555555555555",
    width: 1600,
    height: 900,
    description: "a bright kitchen with a laptop",
    tags: ["kitchen", "laptop"],
  };
  const photos = new Map([[PHOTO.id, PHOTO]]);
  const swap = {
    id: "visual-1",
    kind: "box" as const,
    x: 75,
    y: 1047,
    width: 300,
    photo_id: PHOTO.id,
  };

  it("parses a box move's photo id, and refuses one that is no photo id or on a text", () => {
    expect(parseOwnerMoves([swap])).toEqual([swap]);
    expect(parseOwnerMoves([{ ...swap, photo_id: "kitchen" }])).toBeNull();
    expect(parseOwnerMoves([{ id: "hook", x: 1, y: 2, size: 80, photo_id: PHOTO.id }])).toBeNull();
  });

  it("shows the photo in place of the stand-in, at the photo's aspect ratio, and names it in the inputs", async () => {
    const context = { ...(await contextOf(hook)), photos };
    const applied = applyOwnerMoves(hook.edit, [swap], context);
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const card = applied.edit.tracks.behind!.find((item) => item.id === "visual-1");
    expect(card).toMatchObject({
      kind: "visual",
      photo: { id: PHOTO.id, width: 1600, height: 900 },
      box: { x: 75, y: 1047, width: 300, height: 169 },
    });
    expect(card && "image" in card).toBe(false);
    expect(applied.edit.inputs.photos).toEqual([PHOTO.id]);
    // A photo the caller did not vouch for is refused.
    const unknown = applyOwnerMoves(hook.edit, [swap], await contextOf(hook));
    expect(unknown).toEqual({
      ok: false,
      reasons: [`visual-1: photo ${PHOTO.id} is not a ready photo in your library`],
    });
    expect(settleOwnerMove(hook.edit, swap, await contextOf(hook)).ok).toBe(false);
  });

  it("settles a swap with its photo, counts it as a change, and records it as swapped with what it replaced", async () => {
    const context = { ...(await contextOf(hook)), photos };
    const settled = settleOwnerMove(hook.edit, swap, context);
    if (!settled.ok) throw new Error(settled.reasons.join("; "));
    expect(settled.move).toEqual(swap);
    const before = await componentsOf(hook);
    expect(effectiveMoves([swap], before)).toEqual([swap]);
    const after = await componentsOf(hook, settled.edit);
    expect(byId(after, "visual-1").picture).toBe(PHOTO.id);
    expect(effectiveMoves([swap], before, after)).toEqual([swap]);
    const [record] = ownerMoveRecords({
      ids: ["visual-1"],
      moves: [swap],
      engine: before,
      owner: after,
      edit: settled.edit,
      headTrack: hook.headTrack,
      preset,
      photos,
      transcript: hook.transcript,
    });
    expect(record).toMatchObject({
      item: "visual-1",
      component: "VISUAL",
      added: false,
      swapped: true,
      moved: false,
      resized: true,
      photo_id: PHOTO.id,
      replaced: "assets/visuals/visual-1.jpg",
      context: { photo: { description: PHOTO.description, tags: PHOTO.tags } },
    });
    expect(record!.context.words.length).toBeGreaterThan(0);
  });
});
