import { type EditInputs, type EditRef, maskPath } from "@edit-issebya/edit";
import { isStorageKey, keyPrefix } from "@edit-issebya/storage";

// How the frames sprite is laid out: one row of `columns` frames of
// `width` x `height`, one every `everySeconds` of the footage.
export interface FramesLayout {
  everySeconds: number;
  columns: number;
  width: number;
  height: number;
}

// Where the reel's preview copies are (reels.preview_copies, written by the
// worker after the pipeline): the footage copy, and since the step's version
// 3 a thumbnail and a frames sprite (null on an older reel). An old reel's
// column may also name a cut-out copy, which the preview never reads.
export interface PreviewCopies {
  footage: EditRef;
  thumbnail: EditRef | null;
  frames: ({ ref: EditRef } & FramesLayout) | null;
}

// The objects the live preview reads, as storage keys (the frames sprite
// only when the reel has one), plus the cut-out masks a version with behind
// items names (each at the path its page plays it from) and the library
// photos it shows (by id; their keys come from the photos rows).
export interface PreviewKeys {
  edit: string;
  transcript: string;
  headTrack: string;
  footage: string;
  frames: string | null;
  masks: { path: string; key: string }[];
  photoIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function refOf(ref: EditRef): EditRef {
  return { step: ref.step, fingerprint: ref.fingerprint, file: ref.file };
}

// A whole number in [1, max], as the worker writes the layout.
function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

function layoutOf(value: unknown): FramesLayout | null {
  if (typeof value !== "object" || value === null) return null;
  const { everySeconds, columns, width, height } = value as Record<string, unknown>;
  if (!isCount(everySeconds, 60) || !isCount(columns, 256)) return null;
  if (!isCount(width, 1080) || !isCount(height, 1920)) return null;
  return { everySeconds, columns, width, height };
}

// Narrows the jsonb column; null without a footage ref. The thumbnail and
// the frames sprite (with its layout) are optional: a missing or malformed
// one is null, never a failure. A stored `cutout` (an old reel's) is ignored.
export function parsePreviewCopies(value: unknown): PreviewCopies | null {
  if (typeof value !== "object" || value === null) return null;
  const { footage, thumbnail, frames, frames_layout } = value as Record<string, unknown>;
  if (!isRef(footage)) return null;
  const layout = isRef(frames) ? layoutOf(frames_layout) : null;
  return {
    footage: refOf(footage),
    thumbnail: isRef(thumbnail) ? refOf(thumbnail) : null,
    frames: isRef(frames) && layout ? { ref: refOf(frames), ...layout } : null,
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
  // A malformed sprite ref only loses the footage frames, never the preview.
  const frames = previewCopies.frames
    ? cacheKeyOf(prefix, previewCopies.frames.ref, "preview_copies")
    : null;
  // Masks and photos: a version without them has none; a malformed one is a
  // failure (the page would name a file the preview cannot sign).
  const rawMasks: unknown = inputs.masks ?? [];
  const rawPhotos: unknown = inputs.photos ?? [];
  if (!Array.isArray(rawMasks) || !Array.isArray(rawPhotos)) return null;
  const masks: PreviewKeys["masks"] = [];
  for (const mask of rawMasks) {
    const key = cacheKeyOf(prefix, mask, "cutout");
    if (!key) return null;
    masks.push({ path: maskPath(mask as EditRef), key });
  }
  if (!rawPhotos.every((id) => typeof id === "string" && UUID.test(id))) return null;
  return {
    edit: r2Key,
    transcript,
    headTrack,
    footage,
    frames,
    masks,
    photoIds: [...(rawPhotos as string[])],
  };
}

// The key of the reel's thumbnail, beside its other preview copies under the
// current version key's prefix; null without one or when a part is malformed.
export function thumbnailKey({
  r2Key,
  reelId,
  versionId,
  previewCopies,
}: {
  r2Key: string;
  reelId: string;
  versionId: string;
  previewCopies: PreviewCopies | null;
}): string | null {
  if (!previewCopies?.thumbnail || !isStorageKey(r2Key)) return null;
  const prefix = cachePrefixOf(r2Key, reelId, versionId);
  if (prefix === null) return null;
  return cacheKeyOf(prefix, previewCopies.thumbnail, "preview_copies");
}
