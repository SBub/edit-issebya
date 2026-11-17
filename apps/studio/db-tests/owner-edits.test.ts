import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin, localSupabaseClient } from "../test-support/local-supabase.ts";

// The owner's moves (app_docs/owner-edits.md): the `owner_edit` job, the
// version's `edited_from_id`, and the learning records in `owner_moves`,
// written by `save_version` with the version.

const admin = localSupabaseAdmin();
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let reelA: string;
let reelB: string;
let versionA: string;
let versionB: string;

const INPUTS = {
  footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
  transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
  head_track: { step: "head_track", fingerprint: "h", file: "head-track.json" },
};

// A library photo's id (the column is a plain id, no foreign key).
const PHOTO = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";
// A card the owner adds from the library.
const ADDS = [{ id: "owner-visual-1", photo_id: PHOTO, word: "w0004", x: 600, y: 300, width: 360 }];

// A text's move and a VISUAL's box move, the card turned.
const MOVES = [
  { id: "accent-1", x: 120, y: 900, size: 110 },
  { id: "visual-1", kind: "box", x: 600, y: 700, width: 200, rotation: -20 },
];

function versionArgs(reelId: string, id: string, parentId: string | null) {
  return {
    p_id: id,
    p_reel_id: reelId,
    p_parent_id: parentId,
    p_restored_from_id: null,
    p_request: null,
    p_model: null,
    p_prompt_version: null,
    p_change_summary: null,
    p_checks: [],
    p_inputs: INPUTS,
    p_r2_key: `test/reels/${reelId}/versions/${id}.json`,
  };
}

async function saveVersion(reelId: string, parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.rpc("save_version", versionArgs(reelId, id, parentId));
  if (error) throw new Error(`version not saved: ${error.message}`);
  return id;
}

// One learning record as the worker sends it (`OwnerMoveRecord`).
function moveRecord(item: string, engineVersionId: string, wrapWidth: number | null = null) {
  return {
    item,
    component: "ACCENT",
    variant: "accent/above-head",
    text: "sense of purpose",
    start: 4.2,
    end: 5.75,
    engine: { x: 316, y: 254, width: 448.5, height: 110, size: 110 },
    owner: { x: 120, y: 900, width: 448.5, height: 110, size: 110 },
    moved: true,
    resized: false,
    rotated: false,
    engine_rotation: 0,
    owner_rotation: 0,
    wrap_width: wrapWidth,
    engine_version_id: engineVersionId,
    context: {
      frame: { width: 1080, height: 1920 },
      font_pair: "classic",
      head: { left: 300, right: 780, top: 600, bottom: 1248 },
      engine_zone: "above-head",
      others: [
        {
          item: "w0012",
          component: "CAPTION",
          text: "and",
          start: 4.2,
          end: 4.4,
          box: { x: 500, y: 1290, width: 80, height: 50, size: 50 },
          moved_by_owner: false,
        },
      ],
    },
  };
}

// A VISUAL's learning record: its card's boxes, no text size, turned by the owner.
function visualRecord(engineVersionId: string) {
  return {
    ...moveRecord("visual-1", engineVersionId),
    component: "VISUAL",
    variant: "visual/card",
    text: "a phone on a desk",
    engine: { x: 75, y: 1047, width: 300, height: 383, size: null },
    owner: { x: 600, y: 700, width: 200, height: 255, size: null },
    resized: true,
    rotated: true,
    owner_rotation: -20,
  };
}

async function jobsOf(reelId: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("owner_id, kind, status, owner_edit")
    .eq("reel_id", reelId)
    .order("created_at");
  expect(error).toBeNull();
  return data ?? [];
}

async function movesOf(versionId: string) {
  const { data, error } = await admin
    .from("owner_moves")
    .select(
      "owner_id, reel_id, version_id, from_version_id, engine_version_id, item, component, variant, text, start_seconds, end_seconds, engine_box, owner_box, moved, resized, rotated, engine_rotation, owner_rotation, added, swapped, photo_id, replaced, wrap_width, context",
    )
    .eq("version_id", versionId)
    .order("item");
  expect(error).toBeNull();
  return data ?? [];
}

beforeAll(async () => {
  userA = await createTestUser(admin, "owner-edits-a");
  userB = await createTestUser(admin, "owner-edits-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
  reelA = await insertReel(admin, { ownerId: userA.id, name: "a.mov", status: "processed" });
  reelB = await insertReel(admin, { ownerId: userB.id, name: "b.mov", status: "processed" });
  versionA = await saveVersion(reelA);
  versionB = await saveVersion(reelB);
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  for (const reel of [reelA, reelB].filter(Boolean)) {
    await admin.from("jobs").delete().eq("reel_id", reel);
  }
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("owner_edit jobs", () => {
  it("lets the owner queue their moves for their own reel", async () => {
    const owner_edit = { version_id: versionA, moves: MOVES };
    const { error } = await clientA
      .from("jobs")
      .insert({ reel_id: reelA, kind: "owner_edit", owner_edit });
    expect(error).toBeNull();
    expect(await jobsOf(reelA)).toEqual([
      { owner_id: userA.id, kind: "owner_edit", status: "queued", owner_edit },
    ]);
    await admin.from("jobs").delete().eq("reel_id", reelA);
  });

  it("refuses moves for another owner's reel", async () => {
    const { error } = await clientB.from("jobs").insert({
      reel_id: reelA,
      kind: "owner_edit",
      owner_edit: { version_id: versionA, moves: MOVES },
    });
    expect(error).not.toBeNull();
    expect(await jobsOf(reelA)).toEqual([]);
  });

  it("refuses a signed-out caller", async () => {
    const { error } = await localSupabaseClient()
      .from("jobs")
      .insert({
        reel_id: reelA,
        kind: "owner_edit",
        owner_edit: { version_id: versionA, moves: MOVES },
      });
    expect(error).not.toBeNull();
    expect(await jobsOf(reelA)).toEqual([]);
  });

  it("refuses an owner edit with no payload, and a payload on any other kind", async () => {
    const none = await clientA.from("jobs").insert({ reel_id: reelA, kind: "owner_edit" });
    expect(none.error).not.toBeNull();
    const other = await clientA.from("jobs").insert({
      reel_id: reelA,
      kind: "start_over",
      owner_edit: { version_id: versionA, moves: MOVES },
    });
    expect(other.error).not.toBeNull();
    expect(await jobsOf(reelA)).toEqual([]);
  });

  it("lets the owner queue added cards alone, and a swap with them", async () => {
    const alone = await clientA.from("jobs").insert({
      reel_id: reelA,
      kind: "owner_edit",
      owner_edit: { version_id: versionA, moves: [], adds: ADDS },
    });
    expect(alone.error).toBeNull();
    const swap = { id: "visual-1", kind: "box", x: 600, y: 700, width: 200, photo_id: PHOTO };
    const both = await clientA.from("jobs").insert({
      reel_id: reelA,
      kind: "owner_edit",
      owner_edit: { version_id: versionA, moves: [swap], adds: ADDS },
    });
    expect(both.error).toBeNull();
    expect((await jobsOf(reelA)).map((job) => job.owner_edit)).toEqual([
      { version_id: versionA, moves: [], adds: ADDS },
      { version_id: versionA, moves: [swap], adds: ADDS },
    ]);
    await admin.from("jobs").delete().eq("reel_id", reelA);
  });

  it("refuses a payload that is not a version and a list of one to 200 moves", async () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      id: `accent-${index}`,
      x: 100,
      y: 900,
      size: 50,
    }));
    for (const owner_edit of [
      [],
      "moves",
      { moves: MOVES },
      { version_id: versionA },
      { version_id: versionA, moves: [] },
      { version_id: versionA, moves: {} },
      { version_id: 12, moves: MOVES },
      { version_id: versionA, moves: many },
      // Adds: none in all, not a list, more than 20.
      { version_id: versionA, moves: [], adds: [] },
      { version_id: versionA, moves: [], adds: {} },
      {
        version_id: versionA,
        moves: [],
        adds: Array.from({ length: 21 }, (_, index) => ({
          ...ADDS[0],
          id: `owner-visual-${index + 1}`,
        })),
      },
    ]) {
      const { error } = await clientA
        .from("jobs")
        .insert({ reel_id: reelA, kind: "owner_edit", owner_edit });
      expect({ owner_edit, refused: error !== null }).toEqual({ owner_edit, refused: true });
    }
    expect(await jobsOf(reelA)).toEqual([]);
  });

  it("never lets the owner set the worker's columns on it", async () => {
    const { error } = await clientA.from("jobs").insert({
      reel_id: reelA,
      kind: "owner_edit",
      owner_edit: { version_id: versionA, moves: MOVES },
      status: "done",
    });
    expect(error).not.toBeNull();
    expect(await jobsOf(reelA)).toEqual([]);
  });
});

describe("save_version with the owner's edit", () => {
  let edited: string;

  it("saves the owner's version with the version it was edited from and one learning row per move", async () => {
    edited = randomUUID();
    const { data, error } = await admin.rpc("save_version", {
      ...versionArgs(reelA, edited, versionA),
      p_edited_from_id: versionA,
      p_owner_moves: [
        moveRecord("accent-1", versionA),
        moveRecord("hook", versionA, 412.25),
        visualRecord(versionA),
      ],
    });
    expect(error).toBeNull();
    expect(data).toBe(2);
    const { data: row } = await admin
      .from("versions")
      .select("number, parent_id, edited_from_id, restored_from_id")
      .eq("id", edited)
      .single();
    expect(row).toEqual({
      number: 2,
      parent_id: versionA,
      edited_from_id: versionA,
      restored_from_id: null,
    });
    const record = moveRecord("accent-1", versionA);
    expect(await movesOf(edited)).toEqual([
      {
        owner_id: userA.id,
        reel_id: reelA,
        version_id: edited,
        from_version_id: versionA,
        engine_version_id: versionA,
        item: "accent-1",
        component: "ACCENT",
        variant: "accent/above-head",
        text: "sense of purpose",
        start_seconds: 4.2,
        end_seconds: 5.75,
        engine_box: record.engine,
        owner_box: record.owner,
        moved: true,
        resized: false,
        rotated: false,
        engine_rotation: 0,
        owner_rotation: 0,
        added: false,
        swapped: false,
        photo_id: null,
        replaced: null,
        wrap_width: null,
        context: record.context,
      },
      // The wrap width an edge handle set comes back as it was sent.
      expect.objectContaining({ item: "hook", version_id: edited, wrap_width: 412.25 }),
      // A VISUAL moved, scaled and turned: its boxes with no size, no wrap
      // width, the engine's turn 0 and the owner's.
      expect.objectContaining({
        item: "visual-1",
        component: "VISUAL",
        engine_box: visualRecord(versionA).engine,
        owner_box: visualRecord(versionA).owner,
        resized: true,
        rotated: true,
        engine_rotation: 0,
        owner_rotation: -20,
        wrap_width: null,
      }),
    ]);
  });

  it("saves a swapped card's photo and what it replaced, and an added card with no engine box", async () => {
    // A reel of its own, so the other tests' current versions stay as they are.
    const reel = await insertReel(admin, { ownerId: userA.id, name: "c.mov", status: "processed" });
    const base = await saveVersion(reel);
    const id = randomUUID();
    const swapped = {
      ...visualRecord(versionA),
      swapped: true,
      photo_id: PHOTO,
      replaced: "assets/visuals/visual-1.jpg",
    };
    const added = {
      ...visualRecord(versionA),
      item: "owner-visual-1",
      engine: null,
      moved: false,
      resized: false,
      rotated: false,
      owner_rotation: 0,
      added: true,
      photo_id: PHOTO,
      context: {
        ...visualRecord(versionA).context,
        words: "and if you look",
        photo: { description: "a kitchen", tags: ["kitchen"] },
      },
    };
    const { error } = await admin.rpc("save_version", {
      ...versionArgs(reel, id, base),
      p_edited_from_id: base,
      p_owner_moves: [swapped, added],
    });
    expect(error).toBeNull();
    expect(await movesOf(id)).toEqual([
      expect.objectContaining({
        item: "owner-visual-1",
        engine_box: null,
        added: true,
        swapped: false,
        photo_id: PHOTO,
        replaced: null,
        context: expect.objectContaining({
          words: "and if you look",
          photo: { description: "a kitchen", tags: ["kitchen"] },
        }),
      }),
      expect.objectContaining({
        item: "visual-1",
        engine_box: visualRecord(versionA).engine,
        added: false,
        swapped: true,
        photo_id: PHOTO,
        replaced: "assets/visuals/visual-1.jpg",
      }),
    ]);
    // An added card with an engine box, or a moved one without, is refused.
    const wrong = randomUUID();
    const refused = await admin.rpc("save_version", {
      ...versionArgs(reel, wrong, id),
      p_edited_from_id: base,
      p_owner_moves: [{ ...added, engine: visualRecord(versionA).engine }],
    });
    expect(refused.error).not.toBeNull();
    const noBox = await admin.rpc("save_version", {
      ...versionArgs(reel, wrong, id),
      p_edited_from_id: base,
      p_owner_moves: [{ ...swapped, engine: null }],
    });
    expect(noBox.error).not.toBeNull();
    const { data } = await admin.from("versions").select("id").eq("id", wrong);
    expect(data).toEqual([]);
  });

  it("leaves every other version with no edited-from version and no learning row", async () => {
    const { data } = await admin
      .from("versions")
      .select("edited_from_id")
      .eq("id", versionA)
      .single();
    expect(data).toEqual({ edited_from_id: null });
    expect(await movesOf(versionA)).toEqual([]);
  });

  it("refuses an edited-from version of another reel, writing nothing", async () => {
    const id = randomUUID();
    const { error } = await admin.rpc("save_version", {
      ...versionArgs(reelA, id, edited),
      p_edited_from_id: versionB,
      p_owner_moves: [moveRecord("accent-1", versionB)],
    });
    expect(error).not.toBeNull();
    const { data } = await admin.from("versions").select("id").eq("id", id);
    expect(data).toEqual([]);
    expect(await movesOf(id)).toEqual([]);
  });

  it("refuses learning rows without the version they were made on, a component it does not know and a turn past 180 degrees", async () => {
    const id = randomUUID();
    const orphan = await admin.rpc("save_version", {
      ...versionArgs(reelA, id, edited),
      p_owner_moves: [moveRecord("accent-1", versionA)],
    });
    expect(orphan.error?.message).toMatch(/owner moves need the version they were made on/);
    const caption = await admin.rpc("save_version", {
      ...versionArgs(reelA, id, edited),
      p_edited_from_id: edited,
      p_owner_moves: [{ ...moveRecord("w0001", versionA), component: "CAPTION" }],
    });
    expect(caption.error).not.toBeNull();
    const overTurned = await admin.rpc("save_version", {
      ...versionArgs(reelA, id, edited),
      p_edited_from_id: edited,
      p_owner_moves: [{ ...visualRecord(versionA), owner_rotation: 181 }],
    });
    expect(overTurned.error?.message).toMatch(/owner_moves_owner_rotation_check/);
    // One transaction: the version is not saved either.
    const { data } = await admin.from("versions").select("id").eq("id", id);
    expect(data).toEqual([]);
    const { data: reel } = await admin
      .from("reels")
      .select("current_version_id")
      .eq("id", reelA)
      .single();
    expect(reel).toEqual({ current_version_id: edited });
  });

  it("lets the owner read their own learning rows and no one else's", async () => {
    const own = await clientA.from("owner_moves").select("item").eq("version_id", edited);
    expect(own.error).toBeNull();
    expect((own.data ?? []).map((row) => row.item).sort()).toEqual([
      "accent-1",
      "hook",
      "visual-1",
    ]);
    const other = await clientB.from("owner_moves").select("item").eq("version_id", edited);
    expect(other.data).toEqual([]);
    const anon = await localSupabaseClient().from("owner_moves").select("item");
    expect(anon.data ?? []).toEqual([]);
  });

  it("never lets the owner write, change or delete a learning row", async () => {
    const insert = await clientA.from("owner_moves").insert({
      owner_id: userA.id,
      reel_id: reelA,
      version_id: edited,
      from_version_id: versionA,
      engine_version_id: versionA,
      item: "accent-2",
      component: "ACCENT",
      text: "x",
      start_seconds: 0,
      end_seconds: 1,
      engine_box: {},
      owner_box: {},
      moved: true,
      resized: false,
      context: {},
    });
    expect(insert.error).not.toBeNull();
    await clientA.from("owner_moves").update({ text: "changed" }).eq("version_id", edited);
    await clientA.from("owner_moves").delete().eq("version_id", edited);
    const rows = await movesOf(edited);
    expect(rows.map((row) => row.text)).toEqual([
      "sense of purpose",
      "sense of purpose",
      "a phone on a desk",
    ]);
  });

  it("deletes the learning rows with their reel and keeps another reel's", async () => {
    const otherEdited = randomUUID();
    const saved = await admin.rpc("save_version", {
      ...versionArgs(reelB, otherEdited, versionB),
      p_edited_from_id: versionB,
      p_owner_moves: [moveRecord("accent-1", versionB)],
    });
    expect(saved.error).toBeNull();
    expect(await movesOf(edited)).toHaveLength(3);

    const { error } = await clientA.rpc("delete_reel", { p_reel_id: reelA });
    expect(error).toBeNull();
    const { data } = await admin.from("versions").select("id").eq("reel_id", reelA);
    expect(data).toEqual([]);
    expect(await movesOf(edited)).toEqual([]);
    const { data: left } = await admin.from("owner_moves").select("id").eq("reel_id", reelA);
    expect(left).toEqual([]);
    expect((await movesOf(otherEdited)).map((row) => row.item)).toEqual(["accent-1"]);
  });
});
