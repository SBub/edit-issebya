import { describe, expect, it } from "vitest";
import {
  type NewVersion,
  type VersionObjects,
  type VersionRow,
  type VersionStore,
  canonicalJson,
  restoreVersion,
  saveVersion,
  versionKey,
} from "./versions.ts";
import type { Edit } from "./schema.ts";

const INPUTS = {
  footage: "1".repeat(64),
  transcript: "2".repeat(64),
  cutout: "3".repeat(64),
  headTrack: "4".repeat(64),
};

function editWith(text: string): Edit {
  return {
    format: 1,
    inputs: INPUTS,
    tracks: {
      footage: [],
      cutout: [],
      captions: [{ id: "c1", start: { word: "w0001" }, end: { word: "w0001" }, text }],
      overlays: [],
      transitions: [],
      sounds: [],
    },
  };
}

// In memory, with the database function's rules: numbering, and a parent
// that must be the current version.
function memory() {
  const objects = new Map<string, Uint8Array>();
  const rows = new Map<string, VersionRow>();
  let current: string | null = null;
  const objectStore: VersionObjects = {
    async get(key) {
      return objects.get(key) ?? null;
    },
    async putIfAbsent(key, body) {
      if (objects.has(key)) return "exists";
      objects.set(key, body);
      return "written";
    },
  };
  const store: VersionStore = {
    async current() {
      return current ? { id: current, number: rows.get(current)!.number } : null;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert(row: NewVersion) {
      if (row.parent_id !== current) throw new Error("stale parent");
      const saved = { ...row, number: rows.size + 1 };
      rows.set(row.id, saved);
      current = row.id;
      return saved;
    },
  };
  return { objects, rows, objectStore, store };
}

const meta = (summary: string) => ({
  request: null,
  model: null,
  promptVersion: null,
  changeSummary: summary,
  checks: { ok: true, reasons: [] },
});

describe("versionKey", () => {
  it("puts a version under its reel", () => {
    expect(versionKey("dev/", "r1", "v1")).toBe("dev/reels/r1/versions/v1.json");
  });
});

describe("canonicalJson", () => {
  it("gives the same bytes whatever the key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { e: 3, f: 2 }] }, b: 1 }),
    );
  });
});

describe("saveVersion and restoreVersion", () => {
  it("writes the object and a row", async () => {
    const { objects, objectStore, store } = memory();
    const row = await saveVersion({
      objects: objectStore,
      store,
      prefix: "dev/",
      reelId: "r1",
      id: "v1",
      edit: editWith("one"),
      meta: meta("first"),
    });
    expect(row).toMatchObject({
      id: "v1",
      number: 1,
      parent_id: null,
      r2_key: "dev/reels/r1/versions/v1.json",
    });
    expect(row.inputs).toEqual(INPUTS);
    expect(new TextDecoder().decode(objects.get(row.r2_key))).toBe(canonicalJson(editWith("one")));
  });

  it("refuses an existing key and leaves the first bytes", async () => {
    const { objects, rows, objectStore, store } = memory();
    const target = { objects: objectStore, store, prefix: "", reelId: "r1", id: "v1" };
    await saveVersion({ ...target, edit: editWith("one"), meta: meta("first") });
    const before = objects.get("reels/r1/versions/v1.json");
    await expect(
      saveVersion({ ...target, edit: editWith("two"), meta: meta("again") }),
    ).rejects.toThrow("version object already exists: reels/r1/versions/v1.json");
    expect(objects.get("reels/r1/versions/v1.json")).toBe(before);
    expect(rows.size).toBe(1);
  });

  it("restores v1 after v3 as v4, leaving v1 to v3 unchanged", async () => {
    const { objects, rows, objectStore, store } = memory();
    const target = (id: string) => ({ objects: objectStore, store, prefix: "", reelId: "r1", id });
    for (const [index, text] of ["one", "two", "three"].entries()) {
      await saveVersion({ ...target(`v${index + 1}`), edit: editWith(text), meta: meta(text) });
    }
    const rowsBefore = structuredClone([...rows.values()]);
    const objectsBefore = new Map([...objects].map(([key, value]) => [key, value.slice()]));

    const v4 = await restoreVersion({ ...target("v4"), fromId: "v1" });
    expect(v4).toMatchObject({
      id: "v4",
      number: 4,
      parent_id: "v3",
      restored_from_id: "v1",
      change_summary: "restored version 1",
      model: null,
      request: null,
    });
    expect(objects.get(v4.r2_key)).toEqual(objects.get("reels/r1/versions/v1.json"));
    expect([...rows.values()].slice(0, 3)).toEqual(rowsBefore);
    for (const [key, value] of objectsBefore) expect(objects.get(key)).toEqual(value);
  });

  it("records the free field and what could not be expressed", async () => {
    const { objectStore, store } = memory();
    const target = (id: string) => ({ objects: objectStore, store, prefix: "", reelId: "r1", id });
    const plain = await saveVersion({ ...target("v1"), edit: editWith("one"), meta: meta("x") });
    expect(plain).toMatchObject({ used_free_field: false, free_field: [], unexpressed: [] });

    const styled = editWith("two");
    styled.tracks.captions[0]!.custom = "letter-spacing: 2px";
    const freeField = [{ item: "c1", why: "wider letters" }];
    const v2 = await saveVersion({
      ...target("v2"),
      edit: styled,
      meta: { ...meta("y"), freeField, unexpressed: ["a wobble"] },
    });
    expect(v2).toMatchObject({
      used_free_field: true,
      free_field: freeField,
      unexpressed: ["a wobble"],
    });

    const v3 = await restoreVersion({ ...target("v3"), fromId: "v2" });
    expect(v3).toMatchObject({
      used_free_field: true,
      free_field: freeField,
      unexpressed: ["a wobble"],
    });
  });

  it("derives used_free_field from the edit, never from the claim", async () => {
    const { objectStore, store } = memory();
    const row = await saveVersion({
      objects: objectStore,
      store,
      prefix: "",
      reelId: "r1",
      id: "v1",
      edit: editWith("one"),
      meta: { ...meta("x"), freeField: [{ item: "c1", why: "claimed" }] },
    });
    expect(row.used_free_field).toBe(false);
    expect(row.free_field).toEqual([{ item: "c1", why: "claimed" }]);
  });

  it("refuses to restore a version of another reel", async () => {
    const { objectStore, store } = memory();
    await saveVersion({
      objects: objectStore,
      store,
      prefix: "",
      reelId: "r1",
      id: "v1",
      edit: editWith("one"),
      meta: meta("x"),
    });
    await expect(
      restoreVersion({
        objects: objectStore,
        store,
        prefix: "",
        reelId: "r2",
        id: "v2",
        fromId: "v1",
      }),
    ).rejects.toThrow("no version v1 for reel r2");
  });
});
