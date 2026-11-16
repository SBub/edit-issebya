import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import type { PlacedComponent } from "./components.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import {
  applyOwnerMoves,
  effectiveMoves,
  fitInSafeZone,
  isMovable,
  ownerMoveProblems,
  ownerMoveRecords,
  ownerSizeRange,
  parseOwnerMoves,
  settleOwnerMove,
  withOwnerCutouts,
} from "./owner-edit.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { Edit } from "./schema.ts";
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
      y: 390,
      size: 197,
      height: 197,
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
    expect(new Set(movable)).toEqual(new Set(["ACCENT", "BIGWORD", "LIST"]));
    expect(isMovable({ component: "CAPTION" })).toBe(false);
    expect(isMovable({ component: "VISUAL" })).toBe(false);
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
        "visual-1: not a text component of this version",
        "nothing: not a text component of this version",
        "accent-1: size 20 is outside 30 to 400 px",
        "accent-2: size 401 is outside 30 to 400 px",
        "big-word-1: moved twice",
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
    expect(settled.move.size).toBe(after.size);
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
    expect(written.engine.size).toBe(110);
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
