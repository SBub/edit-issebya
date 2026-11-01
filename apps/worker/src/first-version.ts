import { randomUUID } from "node:crypto";
import {
  type EditInputs,
  ISSEBYA_PRESET,
  type VersionBlobs,
  type VersionRows,
  baselineEdit,
  build,
  headTrackSchema,
  saveVersion,
  transcriptSchema,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { editMeasurer } from "./edit-measurer.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { type StepContext, recordHit, runInProcessStep } from "./step-runner.ts";

const STEP = "first_version";

export interface FirstVersionRun {
  ctx: StepContext;
  storage: Storage;
  rows: VersionRows;
  blobs: VersionBlobs;
  keyPrefix: string;
  // Every pipeline step's fingerprint, from runPipeline.
  fingerprints: Record<string, string>;
  newId?: () => string;
}

// The pipeline outputs version 1 is built from, by producer.
function firstVersionInputs(fingerprints: Record<string, string>): EditInputs {
  const fp = (step: string) => {
    const value = fingerprints[step];
    if (!value) throw new Error(`${STEP}: no fingerprint for ${step}`);
    return value;
  };
  return {
    footage: { step: "retime", fingerprint: fp("retime"), file: "source.mp4" },
    transcript: { step: "retime", fingerprint: fp("retime"), file: "transcript.json" },
    cutout: {
      step: "remove_background",
      fingerprint: fp("remove_background"),
      file: "subject.webm",
    },
    head_track: { step: "head_track", fingerprint: fp("head_track"), file: "head-track.json" },
  };
}

// After the fixed steps: the automatic version 1, built from the issebya
// preset alone (no AI), so the reel has something to play. A reel that
// already has a version (a retried job) keeps it: a hit, nothing written.
// Failed layout checks are stored on the row, never fatal.
export async function saveFirstVersion({
  ctx,
  storage,
  rows,
  blobs,
  keyPrefix,
  fingerprints,
  newId = randomUUID,
}: FirstVersionRun): Promise<void> {
  const started = performance.now();
  const reelId = ctx.job.reel_id;
  if ((await rows.current(reelId)) !== null) {
    await recordHit(ctx, {
      name: STEP,
      summary: "first version kept, reused",
      wallMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return;
  }
  await runInProcessStep(ctx, {
    name: STEP,
    async work() {
      const inputs = firstVersionInputs(fingerprints);
      const read = async (ref: EditInputs[keyof EditInputs]) => {
        const key = cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
        const bytes = await storage.get(key);
        if (!bytes) throw new Error(`${STEP}: input missing: ${key}`);
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      };
      const transcript = transcriptSchema.parse(await read(inputs.transcript));
      const headTrack = headTrackSchema.parse(await read(inputs.head_track));
      const retime = (await read({ ...inputs.transcript, file: "retime.json" })) as {
        durationSeconds?: unknown;
      };
      if (typeof retime.durationSeconds !== "number") {
        throw new Error(`${STEP}: retime.json has no durationSeconds`);
      }
      const edit = baselineEdit(
        transcript,
        { inputs, duration: retime.durationSeconds },
        ISSEBYA_PRESET,
      );
      const { checks } = build(edit, transcript, headTrack, ISSEBYA_PRESET, await editMeasurer());
      ctx.signal.throwIfAborted();
      const saved = await saveVersion(
        { rows, blobs, keyPrefix, newId },
        {
          reelId,
          parentId: null,
          restoredFromId: null,
          request: null,
          model: null,
          promptVersion: null,
          changeSummary: "automatic first version from the issebya style",
          checks,
          edit,
        },
      );
      return { what: `version ${saved.number} saved`, sizeBytes: saved.bytes };
    },
  });
}
