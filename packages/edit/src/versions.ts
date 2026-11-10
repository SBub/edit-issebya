import { canonicalJson } from "./canonical-json.ts";
import type { Check } from "./checks.ts";
import type { EngineNote } from "./engine-note.ts";
import type { Edit, EditInputs } from "./schema.ts";

// One ask of a request as stored with a version written before the change
// box was removed: what was asked, what would satisfy it, the items linked,
// whether the version does it and, when not, the reason. Read back only;
// no version is written with a checklist any more.
export interface ChecklistOutcome {
  ask: string;
  wants: string;
  fulfilled_by: string[];
  done: boolean;
  reason: string | null;
}

// Where a version's edit.json lives. Written once (put-if-absent), never
// replaced.
export function versionKey(prefix: string, reelId: string, versionId: string): string {
  return `${prefix}reels/${reelId}/versions/${versionId}.json`;
}

// A `versions` row as the version operations read it.
export interface StoredVersion {
  id: string;
  reel_id: string;
  number: number;
  parent_id: string | null;
  restored_from_id: string | null;
  checks: Check[];
  inputs: EditInputs;
  r2_key: string;
}

// What `save_version` takes: the row without its number (given by the
// database) or owner (the reel's).
export interface NewVersion {
  id: string;
  reel_id: string;
  parent_id: string | null;
  restored_from_id: string | null;
  request: string | null;
  model: string | null;
  prompt_version: string | null;
  // The owner's short title for the version (Claude's, from decide); null
  // for the first version, a going back and versions saved before titles.
  change_title: string | null;
  change_summary: string | null;
  checks: Check[];
  inputs: EditInputs;
  r2_key: string;
  // The decide records: whether the free style field was used, the items
  // that needed it and why, what the format could not express, and why a
  // first answer was refused (empty when it passed).
  used_free_field: boolean;
  unexpressed: string[];
  free_field: FreeFieldUse[];
  rejected_reasons: string[];
  // The layout engine's record: every item it moved, shrank, wrapped,
  // retimed or dropped, and why; empty for a going back.
  engine_record: EngineNote[];
  // The request checklist: each ask, the items linked, whether the version
  // does it and, when not, why and what the owner can do; empty without a
  // request, for the first version and for a going back.
  checklist: ChecklistOutcome[];
}

export interface FreeFieldUse {
  item: string;
  reason: string;
}

export interface VersionRows {
  // The reel's current version id; null before the first version.
  current(reelId: string): Promise<string | null>;
  get(id: string): Promise<StoredVersion | null>;
  // Inserts the row and makes it the reel's current version in one
  // transaction; refuses a parent that is not the current version. Returns
  // the version's number.
  save(row: NewVersion): Promise<number>;
}

export interface VersionBlobs {
  get(key: string): Promise<Uint8Array | null>;
  putIfAbsent(key: string, bytes: Uint8Array): Promise<"written" | "exists">;
}

export interface VersionDeps {
  rows: VersionRows;
  blobs: VersionBlobs;
  keyPrefix: string;
  // A new version id (a lower-case UUID); the caller's, so this package needs
  // no randomness.
  newId: () => string;
}

export interface SavedVersion {
  id: string;
  number: number;
  key: string;
  bytes: number;
}

export interface VersionMeta {
  reelId: string;
  parentId: string | null;
  restoredFromId: string | null;
  request: string | null;
  model: string | null;
  promptVersion: string | null;
  // Null (or absent) when there is no title.
  changeTitle?: string | null;
  changeSummary: string | null;
  checks: Check[];
  // The decide records; false and empty when not given.
  usedFreeField?: boolean;
  unexpressed?: string[];
  freeField?: FreeFieldUse[];
  rejectedReasons?: string[];
  // The layout engine's record; empty when not given.
  engineRecord?: EngineNote[];
  // The request checklist's outcome; empty when not given.
  checklist?: ChecklistOutcome[];
}

// The canonical bytes of an edit: what a version's blob holds.
export function editBytes(edit: Edit): Uint8Array {
  return new TextEncoder().encode(canonicalJson(edit));
}

async function saveBytes(
  deps: VersionDeps,
  meta: VersionMeta,
  inputs: EditInputs,
  bytes: Uint8Array,
): Promise<SavedVersion> {
  const id = deps.newId();
  const key = versionKey(deps.keyPrefix, meta.reelId, id);
  if ((await deps.blobs.putIfAbsent(key, bytes)) === "exists") {
    throw new Error(`version key exists, versions are never rewritten: ${key}`);
  }
  const number = await deps.rows.save({
    id,
    reel_id: meta.reelId,
    parent_id: meta.parentId,
    restored_from_id: meta.restoredFromId,
    request: meta.request,
    model: meta.model,
    prompt_version: meta.promptVersion,
    change_title: meta.changeTitle ?? null,
    change_summary: meta.changeSummary,
    checks: meta.checks,
    inputs,
    r2_key: key,
    used_free_field: meta.usedFreeField ?? false,
    unexpressed: meta.unexpressed ?? [],
    free_field: meta.freeField ?? [],
    rejected_reasons: meta.rejectedReasons ?? [],
    engine_record: meta.engineRecord ?? [],
    checklist: meta.checklist ?? [],
  });
  return { id, number, key, bytes: bytes.byteLength };
}

// A new version: the edit's blob written put-if-absent, then its row.
export function saveVersion(
  deps: VersionDeps,
  { edit, ...meta }: VersionMeta & { edit: Edit },
): Promise<SavedVersion> {
  return saveBytes(deps, meta, edit.inputs, editBytes(edit));
}

// Going back never rewrites history: a new version copying the old one's
// edit, inputs and checks, its parent the current version.
export async function restoreVersion(
  deps: VersionDeps,
  { reelId, versionId }: { reelId: string; versionId: string },
): Promise<SavedVersion> {
  const old = await deps.rows.get(versionId);
  if (!old || old.reel_id !== reelId)
    throw new Error(`version ${versionId} is not a version of reel ${reelId}`);
  const bytes = await deps.blobs.get(old.r2_key);
  if (!bytes) throw new Error(`version ${versionId}: edit missing at ${old.r2_key}`);
  const current = await deps.rows.current(reelId);
  return saveBytes(
    deps,
    {
      reelId,
      parentId: current,
      restoredFromId: old.id,
      request: null,
      model: null,
      promptVersion: null,
      // The owner reads it; the list titles it `Back to vN` itself.
      changeSummary: `Back to how v${old.number} looked`,
      checks: old.checks,
    },
    old.inputs,
    bytes,
  );
}
