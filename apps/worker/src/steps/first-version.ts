import { randomUUID } from "node:crypto";
import {
  type HeadTrack,
  ISSEBYA,
  type Transcript,
  type VersionStore,
  baselineEdit,
  build,
  createMeasurer,
  saveVersion,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { type StepContext, runInProcessStep } from "../step-runner.ts";
import { fingerprintOf, fontBytes, leaseGuarded, readJson } from "./version-io.ts";

const STEP = "first_version";

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
    name: STEP,
    async work() {
      const current = await versions.current(job.reel_id);
      if (current) return { what: `version ${current.number} already saved`, sizeBytes: null };

      const retime = fingerprintOf(fingerprints, "retime", STEP);
      const headTrackFp = fingerprintOf(fingerprints, "head_track", STEP);
      const transcript = await readJson<Transcript>(
        storage,
        cacheKey(keyPrefix, "retime", retime, "transcript.json"),
        STEP,
      );
      const headTrack = await readJson<HeadTrack>(
        storage,
        cacheKey(keyPrefix, "head_track", headTrackFp, "head-track.json"),
        STEP,
      );
      const edit = baselineEdit(
        transcript,
        {
          footage: retime,
          transcript: retime,
          cutout: fingerprintOf(fingerprints, "remove_background", STEP),
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

      const { objects, store } = leaseGuarded(storage, versions, signal);
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
