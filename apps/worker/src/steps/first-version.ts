import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type HeadTrack,
  ISSEBYA,
  type Preset,
  type Transcript,
  type VersionObjects,
  type VersionStore,
  baselineEdit,
  build,
  createMeasurer,
  saveVersion,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { type StepContext, runInProcessStep } from "../step-runner.ts";

export interface FirstVersionRun {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  // runPipeline's fingerprints, by step name.
  fingerprints: Record<string, string>;
  versions: VersionStore;
  // Tests pass a fixed id.
  newId?: () => string;
}

// The preset's font files, read from the edit package's assets.
async function fontBytes(preset: Preset): Promise<Record<string, Uint8Array>> {
  const fonts: Record<string, Uint8Array> = {};
  for (const [key, font] of Object.entries(preset.fonts)) {
    const url = new URL(import.meta.resolve(`@edit-issebya/edit/assets/${font.file}`));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a preset font inside the edit package
    fonts[key] = new Uint8Array(await readFile(url));
  }
  return fonts;
}

async function readJson<T>(storage: Storage, key: string): Promise<T> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`first_version: input missing: ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function fingerprintOf(fingerprints: Record<string, string>, step: string): string {
  const fingerprint = fingerprints[step];
  if (!fingerprint) throw new Error(`first_version: no fingerprint for ${step}`);
  return fingerprint;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// After the fixed steps: version 1 of the reel's edit, from the issebya
// preset alone (one caption per word), so the preview and the decide step
// have something to start from. A retried job whose reel already has a
// version writes nothing. The version is saved even when its checks fail
// (the decide step fixes it); after a lost lease nothing more is written.
export function firstVersion({
  ctx,
  storage,
  keyPrefix,
  fingerprints,
  versions,
  newId = randomUUID,
}: FirstVersionRun): Promise<void> {
  const { job, signal } = ctx;
  return runInProcessStep(ctx, {
    name: "first_version",
    async work() {
      const current = await versions.current(job.reel_id);
      if (current) return { what: `version ${current.number} already saved`, sizeBytes: null };

      const retime = fingerprintOf(fingerprints, "retime");
      const headTrackFp = fingerprintOf(fingerprints, "head_track");
      const transcript = await readJson<Transcript>(
        storage,
        cacheKey(keyPrefix, "retime", retime, "transcript.json"),
      );
      const headTrack = await readJson<HeadTrack>(
        storage,
        cacheKey(keyPrefix, "head_track", headTrackFp, "head-track.json"),
      );
      const edit = baselineEdit(
        transcript,
        {
          footage: retime,
          transcript: retime,
          cutout: fingerprintOf(fingerprints, "remove_background"),
          headTrack: headTrackFp,
        },
        ISSEBYA,
      );
      const measurer = createMeasurer(await fontBytes(ISSEBYA));
      let checks;
      try {
        ({ checks } = build({ edit, transcript, headTrack, preset: ISSEBYA, measurer }));
      } finally {
        measurer.close();
      }

      // Each write first checks the lease.
      const objects: VersionObjects = {
        get: (key) => storage.get(key),
        putIfAbsent(key, body, options) {
          signal.throwIfAborted();
          return storage.putIfAbsent(key, body, options);
        },
      };
      const store: VersionStore = {
        ...versions,
        insert(row) {
          signal.throwIfAborted();
          return versions.insert(row);
        },
      };
      signal.throwIfAborted();
      const row = await saveVersion({
        objects,
        store,
        prefix: keyPrefix,
        reelId: job.reel_id,
        id: newId(),
        edit,
        meta: {
          request: null,
          model: null,
          promptVersion: null,
          changeSummary: "automatic first version from the issebya style",
          checks,
        },
      });
      const failures = checks.reasons.length;
      const what =
        failures === 0
          ? `version ${row.number} saved`
          : `version ${row.number} saved, ${plural(failures, "check failure")}`;
      return { what, sizeBytes: null };
    },
  });
}
