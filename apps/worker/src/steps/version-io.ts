// What the in-worker version steps (first_version, decide) share: the
// preset's font bytes, cached step outputs read by fingerprint, and version
// writes that first check the lease.
import { readFile } from "node:fs/promises";
import type { Edit, Preset, VersionObjects, VersionStore } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";

// The preset's font files, read from the edit package's assets.
export async function fontBytes(preset: Preset): Promise<Record<string, Uint8Array>> {
  const fonts: Record<string, Uint8Array> = {};
  for (const [key, font] of Object.entries(preset.fonts)) {
    const url = new URL(import.meta.resolve(`@edit-issebya/edit/assets/${font.file}`));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a preset font inside the edit package
    fonts[key] = new Uint8Array(await readFile(url));
  }
  return fonts;
}

// A stored JSON object; a missing one fails the step, naming the key.
export async function readJson<T>(storage: Storage, key: string, step: string): Promise<T> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`${step}: input missing: ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function fingerprintOf(
  fingerprints: Record<string, string>,
  of: string,
  step: string,
): string {
  const fingerprint = fingerprints[of];
  if (!fingerprint) throw new Error(`${step}: no fingerprint for ${of}`);
  return fingerprint;
}

// The step fingerprints a version was made from, by step name: the inverse of
// the mapping first_version uses to build an edit's inputs (footage and
// transcript both come from retime). A change job decides from these, so it
// runs no fixed step.
export function fingerprintsFromInputs(inputs: Edit["inputs"]): Record<string, string> {
  return {
    retime: inputs.transcript,
    head_track: inputs.headTrack,
    remove_background: inputs.cutout,
  };
}

// The version object and row writes, each refused once the lease is lost.
export function leaseGuarded(
  storage: Storage,
  versions: VersionStore,
  signal: AbortSignal,
): { objects: VersionObjects; store: VersionStore } {
  return {
    objects: {
      get: (key) => storage.get(key),
      putIfAbsent(key, body, options) {
        signal.throwIfAborted();
        return storage.putIfAbsent(key, body, options);
      },
    },
    store: {
      ...versions,
      insert(row) {
        signal.throwIfAborted();
        return versions.insert(row);
      },
    },
  };
}
