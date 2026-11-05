import { randomUUID } from "node:crypto";
import {
  type EditInputs,
  ISSEBYA_PRESET,
  type VersionBlobs,
  type VersionRows,
  backgroundSampler,
  baselineEdit,
  build,
  headTrackSchema,
  placeEdit,
  saveVersion,
  transcriptSchema,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { ensureBackgrounds } from "./backgrounds/ensure-backgrounds.ts";
import { editMeasurer } from "./edit-measurer.ts";
import { engineRecordLine } from "./engine-record.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import type { ToolPaths } from "./pipeline/tools.ts";
import { reelOf } from "./queue.ts";
import { type SpawnTool, type StepContext, recordHit, runInProcessStep } from "./step-runner.ts";

export const STEP = "first_version";

const NO_CHOICES = { accents: [], big_words: [], photos: [], transitions: [], word_fixes: [] };

export interface FirstVersionRun {
  ctx: StepContext;
  storage: Storage;
  rows: VersionRows;
  blobs: VersionBlobs;
  keyPrefix: string;
  // Every pipeline step's fingerprint, from runPipeline.
  fingerprints: Record<string, string>;
  // For the footage's background map (the `backgrounds` step) the engine
  // keeps every caption readable over.
  scratchDir: string;
  tools: ToolPaths;
  spawnTool?: SpawnTool;
  recordStored?: (key: string, bytes: number) => Promise<void>;
  newId?: () => string;
  // Where the engine record is logged, one line per version.
  log?: (line: string) => void;
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
    head_track: { step: "head_track", fingerprint: fp("head_track"), file: "head-track.json" },
  };
}

// After the fixed steps: the automatic version 1, built from the issebya
// preset alone (no AI) and placed by the layout engine with no choices
// (captions only), so the reel has something to play. A reel that already
// has a version (a retried job) keeps it: a hit, nothing written. The
// footage's background map comes first (made once, then reused), so the
// engine keeps every caption readable over it. Failed
// layout checks are stored on the row, never fatal; the engine record is
// saved with the version and logged in one line.
export async function saveFirstVersion({
  ctx,
  storage,
  rows,
  blobs,
  keyPrefix,
  fingerprints,
  scratchDir,
  tools,
  spawnTool,
  recordStored,
  newId = randomUUID,
  log = console.log,
}: FirstVersionRun): Promise<void> {
  const started = performance.now();
  const reelId = reelOf(ctx.job);
  if ((await rows.current(reelId)) !== null) {
    await recordHit(ctx, {
      name: STEP,
      summary: "first version kept, reused",
      wallMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return;
  }
  const inputs = firstVersionInputs(fingerprints);
  const map = await ensureBackgrounds({
    ctx,
    storage,
    keyPrefix,
    scratchDir,
    footage: inputs.footage,
    tools,
    spawnTool,
    recordStored,
  });
  await runInProcessStep(ctx, {
    name: STEP,
    async work() {
      const read = async (ref: EditInputs["footage"]) => {
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
      const baseline = baselineEdit(
        transcript,
        { inputs, duration: retime.durationSeconds },
        ISSEBYA_PRESET,
      );
      const measurer = await editMeasurer();
      const { tracks, record } = placeEdit(
        baseline,
        NO_CHOICES,
        transcript,
        headTrack,
        ISSEBYA_PRESET,
        measurer,
        { backgrounds: backgroundSampler(map, ISSEBYA_PRESET.frame) },
      );
      const edit = { ...baseline, tracks };
      const { checks } = build(edit, transcript, headTrack, ISSEBYA_PRESET, measurer);
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
          engineRecord: record,
          edit,
        },
      );
      log(engineRecordLine(reelId, saved.number, record));
      return { what: `version ${saved.number} saved`, sizeBytes: saved.bytes };
    },
  });
}
