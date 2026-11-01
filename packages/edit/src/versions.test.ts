import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "./test-support/fixtures.ts";
import {
  type NewVersion,
  type StoredVersion,
  type VersionDeps,
  editBytes,
  restoreVersion,
  saveVersion,
  versionKey,
} from "./versions.ts";

const edit = FIXTURES[0]!.edit;
const REEL = "11111111-1111-4111-8111-111111111111";

let rows: Map<string, StoredVersion & NewVersion>;
let blobs: Map<string, Uint8Array>;
let ids: number;
let deps: VersionDeps;

beforeEach(() => {
  rows = new Map();
  blobs = new Map();
  ids = 0;
  deps = {
    keyPrefix: "dev/",
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    blobs: {
      async get(key) {
        return blobs.get(key) ?? null;
      },
      async putIfAbsent(key, bytes) {
        if (blobs.has(key)) return "exists";
        blobs.set(key, bytes);
        return "written";
      },
    },
    rows: {
      async current(reelId) {
        const mine = [...rows.values()].filter((row) => row.reel_id === reelId);
        return mine.sort((a, b) => b.number - a.number)[0]?.id ?? null;
      },
      async get(id) {
        return rows.get(id) ?? null;
      },
      async save(row) {
        if (row.parent_id !== (await this.current(row.reel_id))) throw new Error("stale parent");
        const number = [...rows.values()].filter((r) => r.reel_id === row.reel_id).length + 1;
        rows.set(row.id, { ...row, number });
        return number;
      },
    },
  };
});

const meta = (parentId: string | null) => ({
  reelId: REEL,
  parentId,
  restoredFromId: null,
  request: null,
  model: null,
  promptVersion: null,
  changeSummary: "automatic first version from the issebya style",
  checks: [],
});

describe("versions", () => {
  it("writes the blob under the version key, then the row", async () => {
    const saved = await saveVersion(deps, { ...meta(null), edit });
    expect(saved.number).toBe(1);
    expect(saved.key).toBe(versionKey("dev/", REEL, saved.id));
    expect(saved.key).toBe(`dev/reels/${REEL}/versions/${saved.id}.json`);
    expect(blobs.get(saved.key)).toEqual(editBytes(edit));
    expect(rows.get(saved.id)).toMatchObject({
      r2_key: saved.key,
      parent_id: null,
      inputs: edit.inputs,
    });
  });

  it("refuses to write a version key twice and keeps the stored bytes", async () => {
    deps.newId = () => "00000000-0000-4000-8000-000000000001";
    const first = await saveVersion(deps, { ...meta(null), edit });
    const before = blobs.get(first.key);
    await expect(
      saveVersion(deps, { ...meta(first.id), edit: { ...edit, duration: 9 } }),
    ).rejects.toThrow("version key exists, versions are never rewritten");
    expect(blobs.get(first.key)).toBe(before);
    expect(rows.size).toBe(1);
  });

  it("restores v1 from v3 as v4, leaving v1 to v3 unchanged", async () => {
    const v1 = await saveVersion(deps, { ...meta(null), edit });
    const v2 = await saveVersion(deps, { ...meta(v1.id), edit: { ...edit, duration: 2 } });
    const v3 = await saveVersion(deps, { ...meta(v2.id), edit: { ...edit, duration: 1.5 } });
    const snapshot = structuredClone({ rows: [...rows.entries()], blobs: [...blobs.entries()] });

    const v4 = await restoreVersion(deps, { reelId: REEL, versionId: v1.id });

    expect(v4.number).toBe(4);
    expect(rows.get(v4.id)).toMatchObject({
      restored_from_id: v1.id,
      parent_id: v3.id,
      change_summary: "restored version 1",
      inputs: edit.inputs,
      checks: [],
    });
    expect(blobs.get(v4.key)).toEqual(blobs.get(v1.key));
    expect([...rows.entries()].filter(([id]) => id !== v4.id)).toEqual(snapshot.rows);
    expect([...blobs.entries()].filter(([key]) => key !== v4.key)).toEqual(snapshot.blobs);
  });

  it("restores the current version as a new copy", async () => {
    const v1 = await saveVersion(deps, { ...meta(null), edit });
    const v2 = await restoreVersion(deps, { reelId: REEL, versionId: v1.id });
    expect(rows.get(v2.id)).toMatchObject({ number: 2, parent_id: v1.id, restored_from_id: v1.id });
  });

  it("refuses to restore a version of another reel", async () => {
    const v1 = await saveVersion(deps, { ...meta(null), edit });
    await expect(
      restoreVersion(deps, { reelId: "22222222-2222-4222-8222-222222222222", versionId: v1.id }),
    ).rejects.toThrow("is not a version of reel");
  });

  it("serialises an edit canonically, whatever its key order", () => {
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, item]) => [key, reversed(item)]),
            )
          : value;
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    expect(text(editBytes(reversed(edit) as typeof edit))).toBe(text(editBytes(edit)));
    expect(JSON.parse(text(editBytes(edit)))).toEqual(edit);
  });
});
