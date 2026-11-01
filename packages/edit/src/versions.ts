import type { CheckResult } from "./checks.ts";
import { type Edit, type Item, TRACKS } from "./schema.ts";

// Where a version's edit lives: one object per version, never replaced.
export function versionKey(prefix: string, reelId: string, versionId: string): string {
  return `${prefix}reels/${reelId}/versions/${versionId}.json`;
}

// The two calls a version needs from object storage; `Storage` from
// @edit-issebya/storage has both.
export interface VersionObjects {
  get(key: string): Promise<Uint8Array | null>;
  putIfAbsent(
    key: string,
    body: Uint8Array,
    options?: { contentType?: string },
  ): Promise<"written" | "exists">;
}

export interface VersionRow {
  id: string;
  reel_id: string;
  number: number;
  parent_id: string | null;
  restored_from_id: string | null;
  request: string | null;
  model: string | null;
  prompt_version: string | null;
  change_summary: string | null;
  checks: CheckResult;
  inputs: Edit["inputs"];
  r2_key: string;
  // Any item of the edit sets `custom`: computed from the saved edit.
  used_free_field: boolean;
  // The AI's account of each `custom` it set, and what it could not express.
  free_field: FreeFieldUse[];
  unexpressed: string[];
}

export interface FreeFieldUse {
  item: string;
  why: string;
}

export type NewVersion = Omit<VersionRow, "number">;

export interface VersionStore {
  // The reel's current version, or null before the first.
  current(reelId: string): Promise<{ id: string; number: number } | null>;
  get(versionId: string): Promise<VersionRow | null>;
  // Numbers the row, inserts it and makes it the reel's current version, in
  // one step; refuses a parent that is no longer current.
  insert(row: NewVersion): Promise<VersionRow>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

// Sorted keys, two-space indent, a final newline: the same edit always gives
// the same bytes.
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export interface VersionMeta {
  request: string | null;
  model: string | null;
  promptVersion: string | null;
  changeSummary: string | null;
  checks: CheckResult;
  // Both default to [].
  freeField?: FreeFieldUse[];
  unexpressed?: string[];
}

// Whether any item in any track sets the free `custom` field.
function usesFreeField(edit: Edit): boolean {
  return TRACKS.some((track) => {
    const items: Item[] = edit.tracks[track];
    return items.some((item) => item.custom !== undefined);
  });
}

interface Target {
  objects: VersionObjects;
  store: VersionStore;
  prefix: string;
  reelId: string;
  // The new version's id; the caller makes it (the package has no randomness).
  id: string;
}

async function write(
  { objects, store, prefix, reelId, id }: Target,
  bytes: Uint8Array,
  row: Omit<NewVersion, "id" | "reel_id" | "parent_id" | "r2_key">,
): Promise<VersionRow> {
  const key = versionKey(prefix, reelId, id);
  const parent = await store.current(reelId);
  // The object first: a row never names a missing object.
  const written = await objects.putIfAbsent(key, bytes, { contentType: "application/json" });
  if (written === "exists") throw new Error(`version object already exists: ${key}`);
  return store.insert({ ...row, id, reel_id: reelId, parent_id: parent?.id ?? null, r2_key: key });
}

// Saves a new version: the edit's canonical JSON under a key no object has
// yet, then its row, which becomes the reel's current version.
export function saveVersion(
  target: Target & { edit: Edit; meta: VersionMeta },
): Promise<VersionRow> {
  const { edit, meta } = target;
  return write(target, new TextEncoder().encode(canonicalJson(edit)), {
    restored_from_id: null,
    request: meta.request,
    model: meta.model,
    prompt_version: meta.promptVersion,
    change_summary: meta.changeSummary,
    checks: meta.checks,
    inputs: edit.inputs,
    used_free_field: usesFreeField(edit),
    free_field: meta.freeField ?? [],
    unexpressed: meta.unexpressed ?? [],
  });
}

// Restoring makes a new version with the old one's bytes; the old row and
// object are never touched.
export async function restoreVersion(target: Target & { fromId: string }): Promise<VersionRow> {
  const from = await target.store.get(target.fromId);
  if (!from || from.reel_id !== target.reelId) {
    throw new Error(`no version ${target.fromId} for reel ${target.reelId}`);
  }
  const bytes = await target.objects.get(from.r2_key);
  if (!bytes) throw new Error(`version object missing: ${from.r2_key}`);
  return write(target, bytes, {
    restored_from_id: from.id,
    request: null,
    model: null,
    prompt_version: null,
    change_summary: `restored version ${from.number}`,
    checks: from.checks,
    inputs: from.inputs,
    // They describe the edit's bytes, which are the same.
    used_free_field: from.used_free_field,
    free_field: from.free_field,
    unexpressed: from.unexpressed,
  });
}
