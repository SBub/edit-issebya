import { assertStorageKey, cacheKey } from "@edit-issebya/storage";

// What a version row says about its inputs: the producing steps' fingerprints.
export interface VersionInputs {
  footage: string;
  transcript: string;
  cutout: string;
  headTrack: string;
}

export interface PreviewKeys {
  version: string;
  transcript: string;
  headTrack: string;
  footage: string;
  cutout: string;
}

// The five storage objects the preview of one version reads: the version's
// edit, the retimed transcript and the head track it was built from, and the
// two small preview copies of the reel (found through
// reels.preview_copies_fingerprint), in the key layout the worker writes. The
// worker stored the version at `<prefix>reels/<reel>/versions/<id>.json` with
// the same prefix as its cache, so the prefix is read from that key, never
// from the studio's own settings.
export function previewKeys({
  reelId,
  version,
  previewFingerprint,
}: {
  reelId: string;
  version: {
    id: string;
    r2_key: string;
    inputs: Pick<VersionInputs, "transcript" | "headTrack">;
  };
  previewFingerprint: string;
}): PreviewKeys {
  const key = assertStorageKey(version.r2_key);
  const suffix = `reels/${reelId}/versions/${version.id}.json`;
  if (!key.endsWith(suffix)) throw new Error(`unexpected version key: ${key}`);
  const prefix = key.slice(0, key.length - suffix.length);
  return {
    version: key,
    transcript: cacheKey(prefix, "retime", version.inputs.transcript, "transcript.json"),
    headTrack: cacheKey(prefix, "head_track", version.inputs.headTrack, "head-track.json"),
    footage: cacheKey(prefix, "preview_copies", previewFingerprint, "footage.mp4"),
    cutout: cacheKey(prefix, "preview_copies", previewFingerprint, "subject.webm"),
  };
}
