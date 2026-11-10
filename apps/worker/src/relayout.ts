import {
  type EditRef,
  type EngineInput,
  type FontPairId,
  ISSEBYA_PRESET,
  type Measurer,
  type Preset,
  type Transcript,
  type VersionBlobs,
  type VersionRows,
  build,
  editFromAnswer,
  headTrackSchema,
  parseDecideAnswer,
  parseEdit,
  parseHookAnswer,
  saveVersion,
  transcriptSchema,
  usedFreeField,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { randomUUID } from "node:crypto";
import { NO_USAGE } from "./ai.ts";
import {
  type AiRecord,
  type AiRecordCall,
  aiRecordKey,
  writeAiRecord,
} from "./decide/ai-record.ts";
import { ensureCutouts } from "./cutout/ensure-cutouts.ts";
import { withMasks } from "./cutout/spans.ts";
import { editMeasurer } from "./edit-measurer.ts";
import { engineRecordLine } from "./engine-record.ts";
import { PermanentError } from "./failure.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { type ToolPaths } from "./pipeline/tools.ts";
import { reelOf } from "./queue.ts";
import { type SpawnTool, type StepContext, runToolsStep } from "./step-runner.ts";

export const STEP = "relayout";

// Nothing chosen: the placement of a version that never had an AI answer (the
// first version: captions only, no hook).
const NO_ANSWER: EngineInput = {
  accents: [],
  questions: [],
  big_words: [],
  visuals: [],
  lists: [],
  word_fixes: [],
  hook: null,
};

export interface RelayoutRun {
  ctx: StepContext;
  storage: Storage;
  rows: VersionRows;
  blobs: VersionBlobs;
  keyPrefix: string;
  scratchDir: string;
  tools: ToolPaths;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  recordStored?: (key: string, bytes: number) => Promise<void>;
  // The job's target font pair (`jobs.font_pair`).
  fontPair: FontPairId;
  measurer?: (pair: FontPairId) => Promise<Measurer>;
  newId?: () => string;
  log?: (line: string) => void;
}

// The answer a version was decided from, read from its AI record: the last
// decide call that returned an answer (the one the version saved, since a
// second attempt only runs after a refused first) and the last hook call. A
// record with no decide answer, or an answer that no longer parses, is a
// permanent failure: nothing is guessed. No record means no answer at all.
export function answerOfRecord(
  record: AiRecord | null,
  preset: Preset,
  transcript: Transcript,
): EngineInput {
  if (record === null) return NO_ANSWER;
  const decide = lastAnswered(record.calls, "decide");
  if (!decide) throw new PermanentError(`${STEP}: the AI record has no decide answer`);
  const components = parseDecideAnswer(parseJson(decide, "decide"), preset, transcript);
  if (!components.ok) {
    throw new PermanentError(`${STEP}: the stored decide answer no longer parses`, {
      cause: components.reasons.join("; "),
    });
  }
  const hookCall = lastAnswered(record.calls, "hook");
  let hook: EngineInput["hook"] = null;
  if (hookCall) {
    const written = parseHookAnswer(parseJson(hookCall, "hook"), preset);
    if (!written.ok) {
      throw new PermanentError(`${STEP}: the stored hook answer no longer parses`, {
        cause: written.reasons.join("; "),
      });
    }
    hook = { text: written.text };
  }
  return { ...components.answer, hook };
}

function lastAnswered(calls: readonly AiRecordCall[], role: AiRecordCall["role"]) {
  const matching = calls.filter((call) => call.role === role && call.answerText !== null);
  return matching.at(-1) ?? null;
}

function parseJson(call: AiRecordCall, role: string): unknown {
  try {
    return JSON.parse(call.answerText ?? "");
  } catch (error) {
    throw new PermanentError(`${STEP}: the stored ${role} answer is not JSON`, { cause: error });
  }
}

// The AI record a version was saved with, or null when it has none.
async function readAiRecord(
  storage: Pick<Storage, "get">,
  keyPrefix: string,
  reelId: string,
  versionId: string,
): Promise<AiRecord | null> {
  const bytes = await storage.get(aiRecordKey(keyPrefix, reelId, versionId));
  if (!bytes) return null;
  const record = JSON.parse(new TextDecoder().decode(bytes)) as AiRecord;
  if (!Array.isArray(record.calls)) {
    throw new PermanentError(`${STEP}: the AI record of version ${versionId} has no calls`);
  }
  return record;
}

// A re-layout job's one step (no AI call): the reel's current version placed
// again in the job's font pair. Its answer is the one the version was decided
// from (its AI record), so the words, the accents, the hook and the lists are
// the same and only the layout moves. The result is saved as a new version
// after the current one, with the same AI record copied under the new id, so
// a later re-layout of it finds the same answer. Cut-outs are made only for
// spans the new placement needs; the cache reuses the rest.
export async function runRelayout({
  ctx,
  storage,
  rows,
  blobs,
  keyPrefix,
  scratchDir,
  tools,
  spawnTool,
  env = process.env,
  recordStored,
  fontPair,
  measurer = editMeasurer,
  newId = randomUUID,
  log = console.log,
}: RelayoutRun): Promise<void> {
  return runToolsStep(ctx, {
    name: STEP,
    async work(_tool, stepContext) {
      const reelId = reelOf(ctx.job);
      const currentId = await rows.current(reelId);
      if (currentId === null) throw new PermanentError(`${STEP}: the reel has no current version`);
      const row = await rows.get(currentId);
      if (!row || row.reel_id !== reelId) {
        throw new PermanentError(`${STEP}: version ${currentId} of this reel not found`);
      }
      const bytes = await blobs.get(row.r2_key);
      if (!bytes) throw new Error(`${STEP}: edit missing at ${row.r2_key}`);
      const read = async (ref: EditRef) => {
        const key = cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
        const stored = await storage.get(key);
        if (!stored) throw new Error(`${STEP}: input missing: ${key}`);
        return JSON.parse(new TextDecoder().decode(stored)) as unknown;
      };
      const transcript = transcriptSchema.parse(await read(row.inputs.transcript));
      const headTrack = headTrackSchema.parse(await read(row.inputs.head_track));
      const preset = ISSEBYA_PRESET;
      const parsed = parseEdit(JSON.parse(new TextDecoder().decode(bytes)), preset, transcript);
      if (!parsed.ok) {
        throw new PermanentError(
          `${STEP}: current version does not parse: ${parsed.reasons.join("; ")}`,
        );
      }
      const record = await readAiRecord(storage, keyPrefix, reelId, currentId);
      const answer = answerOfRecord(record, preset, transcript);

      const measure = await measurer(fontPair);
      // The version is set in the target pair; the layout places it there.
      const current = { ...parsed.edit, font_pair: fontPair };
      const composed = editFromAnswer(current, answer, preset, transcript, headTrack, measure);
      if (!composed.ok) {
        throw new PermanentError(
          `${STEP}: the answer no longer places: ${composed.reasons.join("; ")}`,
        );
      }
      const { checks } = build(
        withMasks(composed.edit, transcript),
        transcript,
        headTrack,
        preset,
        measure,
        {
          engineRecord: composed.record,
        },
      );
      const edit = await ensureCutouts({
        ctx,
        storage,
        keyPrefix,
        scratchDir,
        edit: composed.edit,
        transcript,
        tools,
        spawnTool,
        env,
        recordStored,
        parent: stepContext,
      });
      ctx.signal.throwIfAborted();

      // The AI record first, under the new version's id, a copy of the one the
      // answer came from: a version is never saved without its record.
      const versionId = newId();
      if (record !== null) {
        await writeAiRecord(storage, keyPrefix, {
          ...record,
          reel_id: reelId,
          version_id: versionId,
        });
      }
      const saved = await saveVersion(
        { rows, blobs, keyPrefix, newId: () => versionId },
        {
          reelId,
          parentId: currentId,
          restoredFromId: null,
          request: null,
          // No AI call was made: no model.
          model: null,
          promptVersion: record?.prompt_version ?? null,
          // A re-layout is not a change: no title and no summary.
          changeTitle: null,
          changeSummary: null,
          checks,
          usedFreeField: usedFreeField(edit),
          unexpressed: [],
          freeField: [],
          rejectedReasons: [],
          engineRecord: composed.record,
          checklist: [],
          edit,
        },
      );
      log(engineRecordLine(reelId, saved.number, composed.record));
      return {
        what: `version ${saved.number}: set in the ${fontPair} font pair, from version ${row.number}`,
        ai: NO_USAGE,
      };
    },
  });
}
