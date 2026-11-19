import {
  type EditRef,
  type EngineInput,
  type FontPairId,
  ISSEBYA_PRESET,
  type Measurer,
  type Preset,
  type StoredCorrection,
  type StoredVersion,
  type Transcript,
  type VersionBlobs,
  type VersionRows,
  applyWordCorrections,
  build,
  carryOwnerEdits,
  editFromAnswer,
  headTrackSchema,
  keepOwnerAdds,
  liveCorrections,
  ownerPictures,
  withOwnerCutouts,
  parseDecideAnswer,
  parseEdit,
  parseHookAnswer,
  saveVersion,
  transcriptSchema,
  usedFreeField,
  withWordCorrections,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { trace } from "@opentelemetry/api";
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
import { inSpan } from "./telemetry.ts";
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
  // The reel's transcript corrections (`word-corrections-store.ts`). None by
  // default.
  corrections?: () => Promise<StoredCorrection[]>;
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

// How far back a version's answer is looked for (`answerRecord`).
const CHAIN_MAX = 200;

// The AI record that holds a version's answer: its own, or, when it has none,
// the record of the version it copies. A going back copies an old version's
// bytes and no record, so its answer is the old version's; the walk goes back
// through each going back and owner edit (which keep the answer and the item
// ids) to the first version that has a record. Null when none has: the first
// version, or a copy of it.
async function answerRecord(
  storage: Pick<Storage, "get">,
  rows: VersionRows,
  keyPrefix: string,
  version: StoredVersion,
): Promise<AiRecord | null> {
  let at = version;
  for (let hop = 0; hop < CHAIN_MAX; hop += 1) {
    const record = await readAiRecord(storage, keyPrefix, version.reel_id, at.id);
    if (record) return record;
    const before = at.restored_from_id ?? at.edited_from_id;
    if (!before) return null;
    const row = await rows.get(before);
    if (!row || row.reel_id !== version.reel_id) return null;
    at = row;
  }
  return null;
}

// A re-layout job's one step (no AI call): the reel's current version placed
// again in the job's font pair. Its answer is the one the version was decided
// from (its AI record), so the words, the accents, the hook and the lists are
// the same and only the layout moves. The owner's pictures do not depend on
// the font, so they stay: a card the owner gave a library photo is placed
// again showing it, and a card the owner added is kept as it was
// (`ownerPictures`, `keepOwnerAdds`). The captions are written from the
// transcript with the reel's corrections (`owner-corrections.ts`), which win
// over the answer's word fixes. Everything else the owner did by hand in the
// version is carried too (`carryOwnerEdits`): the text fixes of its accents,
// questions, big words, lists and hook and the places, measured and wrapped
// again in the new pair. The result is saved as a new version
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
  corrections = () => Promise.resolve([]),
  measurer = editMeasurer,
  newId = randomUUID,
  log = console.log,
}: RelayoutRun): Promise<void> {
  return runToolsStep(ctx, {
    name: STEP,
    async work(_tool, stepContext) {
      // The job's pair, on the step's span.
      trace.getSpan(stepContext)?.setAttribute("relayout.font_pair", fontPair);
      const reelId = reelOf(ctx.job);
      // The current version, its inputs and the answer it was decided from.
      const loaded = await inSpan(ctx.telemetry, stepContext, "relayout.load", {}, async (span) => {
        const currentId = await rows.current(reelId);
        if (currentId === null)
          throw new PermanentError(`${STEP}: the reel has no current version`);
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
        const record = await answerRecord(storage, rows, keyPrefix, row);
        const answer = answerOfRecord(record, preset, transcript);
        const fixes = liveCorrections(await corrections(), transcript);
        span.setAttributes({
          "relayout.version": row.number,
          "relayout.inputs": (["footage", "transcript", "head_track"] as const)
            .map((name) => `${name}=${row.inputs[name].step}`)
            .join(","),
          "relayout.ai_record": record !== null,
          "relayout.ai_calls": record?.calls.length ?? 0,
        });
        return { currentId, row, transcript, headTrack, preset, parsed, record, answer, fixes };
      });
      const { currentId, row, transcript, headTrack, preset, parsed, record, answer, fixes } =
        loaded;

      // The layout: the answer placed in the job's pair, then built for its checks.
      const placed = await inSpan(
        ctx.telemetry,
        stepContext,
        "relayout.engine",
        { "relayout.font_pair": fontPair, "relayout.from_version_id": currentId },
        async (span) => {
          const measure = await measurer(fontPair);
          // The version is set in the target pair; the layout places it there.
          const current = { ...parsed.edit, font_pair: fontPair };
          // The photos the owner swapped onto the answer's cards go with it:
          // the engine places each such card at its photo's aspect.
          const answered = editFromAnswer(
            current,
            withWordCorrections(answer, fixes),
            preset,
            transcript,
            headTrack,
            measure,
            ownerPictures(parsed.edit),
          );
          if (!answered.ok) {
            throw new PermanentError(
              `${STEP}: the answer no longer places: ${answered.reasons.join("; ")}`,
            );
          }
          // The cards the owner added are in no answer: kept as they were.
          // The reel's corrections next: a caption typed over several spoken
          // words is one caption again, each corrected caption marked as the
          // owner's. Then everything else the owner did by hand in the version
          // (`edit.owner`): each element's text fix written again and each
          // place kept (its top, its centre line and its size), measured and
          // wrapped in the new pair; a box that no longer fits the safe zone
          // is moved in and noted, never dropped (`carryOwnerEdits`).
          const corrected = applyWordCorrections(
            keepOwnerAdds(parsed.edit, answered.edit, { transcript, preset }),
            fixes,
            { transcript, headTrack, preset, measurer: measure },
          );
          const carried = carryOwnerEdits(parsed.edit, corrected.edit, {
            transcript,
            headTrack,
            preset,
            fromMeasurer: await measurer(parsed.edit.font_pair),
            measurer: measure,
          });
          const marks = carried.edit.owner;
          const composed = {
            ...answered,
            // A big word the owner placed or reworded: its cut-out decided again.
            edit: withOwnerCutouts(
              carried.edit,
              [...(marks?.placed ?? []), ...(marks?.texts ?? [])],
              { transcript, headTrack, preset, measurer: measure },
            ),
            record: [...answered.record, ...corrected.notes, ...carried.notes],
            carried: {
              kept: corrected.kept + carried.kept,
              dropped: corrected.dropped + carried.dropped,
            },
          };
          const { checks } = build(
            withMasks(composed.edit, transcript, headTrack),
            transcript,
            headTrack,
            preset,
            measure,
            {
              engineRecord: composed.record,
            },
          );
          const { overlays } = composed.edit.tracks;
          span.setAttributes({
            "relayout.picks_placed": overlays.length + (composed.edit.tracks.behind ?? []).length,
            "relayout.checks": checks.length,
          });
          return { composed, checks };
        },
      );
      const { composed, checks } = placed;
      const edit = await ensureCutouts({
        ctx,
        storage,
        keyPrefix,
        scratchDir,
        edit: composed.edit,
        transcript,
        headTrack,
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
      const saved = await inSpan(ctx.telemetry, stepContext, "relayout.save_version", {}, () =>
        saveVersion(
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
        ),
      );
      log(engineRecordLine(reelId, saved.number, composed.record));
      const { kept, dropped } = composed.carried;
      const yours = [
        ...(kept > 0 ? [`${kept} of your edits kept`] : []),
        ...(dropped > 0 ? [`${dropped} of your edits could not be kept`] : []),
      ];
      return {
        what: [
          `version ${saved.number}: set in the ${fontPair} font pair, from version ${row.number}`,
          ...yours,
        ].join(", "),
        ai: NO_USAGE,
      };
    },
  });
}
