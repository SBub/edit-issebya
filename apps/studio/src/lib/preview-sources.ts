import type { EditInputs, EditRef } from "@edit-issebya/edit";
import { isStorageKey, keyPrefix } from "@edit-issebya/storage";

// Where the reel's preview copy is (reels.preview_copies, written by the
// worker after the pipeline): the footage only. An old reel's column may also
// name a cut-out copy, which the preview never reads.
export interface PreviewCopies {
  footage: EditRef;
}

// The four objects the live preview reads, as storage keys.
export interface PreviewKeys {
  edit: string;
  transcript: string;
  headTrack: string;
  footage: string;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;
const STEP = /^[a-z0-9_]+$/;
const FILE = /^[a-z0-9][a-z0-9._-]*$/;

// The worker writes the step cache and the versions under one prefix, so the
// cache prefix is the version key's: `<prefix>reels/<reel>/versions/<v>.json`.
// null when the key does not end that way or the prefix is malformed.
export function cachePrefixOf(r2Key: string, reelId: string, versionId: string): string | null {
  const suffix = `reels/${reelId}/versions/${versionId}.json`;
  if (!r2Key.endsWith(suffix)) return null;
  const prefix = r2Key.slice(0, -suffix.length);
  return keyPrefix({ R2_KEY_PREFIX: prefix }) === prefix ? prefix : null;
}

function isRef(value: unknown): value is EditRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.step === "string" &&
    typeof ref.fingerprint === "string" &&
    typeof ref.file === "string"
  );
}

// Narrows the jsonb column; null without a footage ref. A stored `cutout`
// (an old reel's) is ignored.
export function parsePreviewCopies(value: unknown): PreviewCopies | null {
  if (typeof value !== "object" || value === null) return null;
  const { footage } = value as Record<string, unknown>;
  if (!isRef(footage)) return null;
  return {
    footage: { step: footage.step, fingerprint: footage.fingerprint, file: footage.file },
  };
}

// One cached step output's key, or null when a part is not what the worker
// writes (a step name, 64 lower-case hex, a plain file name).
function cacheKeyOf(prefix: string, ref: unknown, step: string | null): string | null {
  if (!isRef(ref)) return null;
  if (step !== null && ref.step !== step) return null;
  if (!STEP.test(ref.step) || !FINGERPRINT.test(ref.fingerprint) || !FILE.test(ref.file)) {
    return null;
  }
  const key = `${prefix}cache/${ref.step}/${ref.fingerprint}/${ref.file}`;
  return isStorageKey(key) ? key : null;
}

// The keys of the current version's edit, transcript and head track and of
// the reel's footage preview copy; null when any part is malformed.
export function previewKeys({
  r2Key,
  reelId,
  versionId,
  inputs,
  previewCopies,
}: {
  r2Key: string;
  reelId: string;
  versionId: string;
  inputs: EditInputs | null;
  previewCopies: PreviewCopies | null;
}): PreviewKeys | null {
  if (!inputs || !previewCopies || !isStorageKey(r2Key)) return null;
  const prefix = cachePrefixOf(r2Key, reelId, versionId);
  if (prefix === null) return null;
  const transcript = cacheKeyOf(prefix, inputs.transcript, null);
  const headTrack = cacheKeyOf(prefix, inputs.head_track, "head_track");
  const footage = cacheKeyOf(prefix, previewCopies.footage, "preview_copies");
  if (!transcript || !headTrack || !footage) return null;
  return { edit: r2Key, transcript, headTrack, footage };
}
