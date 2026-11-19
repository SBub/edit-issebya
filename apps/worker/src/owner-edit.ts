import {
  type Edit,
  type EditRef,
  type FontPairId,
  ISSEBYA_PRESET,
  type Measurer,
  type OwnerAdd,
  type OwnerMove,
  type OwnerPhotos,
  type OwnerText,
  type StoredVersion,
  type VersionBlobs,
  type VersionRows,
  applyOwnerAdds,
  applyOwnerMoves,
  applyOwnerTexts,
  build,
  effectiveMoves,
  effectiveTexts,
  headTrackSchema,
  ownerMoveProblems,
  ownerMoveRecords,
  ownerTextRecords,
  parseEdit,
  parseOwnerAdds,
  parseOwnerMoves,
  parseOwnerTexts,
  saveVersion,
  transcriptSchema,
  usedFreeField,
  withOwnerCutouts,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { randomUUID } from "node:crypto";
import { NO_USAGE } from "./ai.ts";
import { type AiRecord, aiRecordKey, writeAiRecord } from "./decide/ai-record.ts";
import { ensureCutouts } from "./cutout/ensure-cutouts.ts";
import { withMasks } from "./cutout/spans.ts";
import { editMeasurer } from "./edit-measurer.ts";
import { PermanentError } from "./failure.ts";
import type { PhotoLibrary } from "./photos/photo-store.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { type ToolPaths } from "./pipeline/tools.ts";
import { reelOf } from "./queue.ts";
import { type SpawnTool, type StepContext, runToolsStep } from "./step-runner.ts";

export const STEP = "owner_edit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// How far back the search for the engine-placed version goes: more than any
// reel's chain of edits and goings back.
const CHAIN_MAX = 200;

// An `owner_edit` job's payload (`jobs.owner_edit`): the version the owner
// edited, the moves (a swap is a box move with a `photo_id`), the cards the
// owner added, each showing a library photo, and the texts the owner edited.
export interface OwnerEdit {
  versionId: string;
  moves: OwnerMove[];
  adds?: OwnerAdd[];
  texts?: OwnerText[];
}

// The payload as the job carries it (the owner's own JSON, untrusted): null
// when it is not `{ version_id, moves, adds?, texts? }` with a version id, a
// list of moves, a list of added cards and a list of text edits, at least one
// move, card or text in all.
export function parseOwnerEdit(json: unknown): OwnerEdit | null {
  if (typeof json !== "object" || json === null) return null;
  const { version_id: versionId, moves, adds, texts } = json as Record<string, unknown>;
  if (typeof versionId !== "string" || !UUID.test(versionId)) return null;
  const added = parseOwnerAdds(adds);
  if (!added) return null;
  const edited = parseOwnerTexts(texts);
  if (!edited) return null;
  const parsed = Array.isArray(moves) && moves.length === 0 ? [] : parseOwnerMoves(moves);
  if (!parsed || parsed.length + added.length + edited.length === 0) return null;
  return {
    versionId,
    moves: parsed,
    ...(added.length > 0 ? { adds: added } : {}),
    ...(edited.length > 0 ? { texts: edited } : {}),
  };
}

export interface OwnerEditRun {
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
  // The job's payload (`jobs.owner_edit`).
  ownerEdit: OwnerEdit;
  measurer?: (pair: FontPairId) => Promise<Measurer>;
  newId?: () => string;
  // The owner's ready library photos: a swap's or an added card's photo is
  // checked and sized from them, never from the job.
  photos?: PhotoLibrary;
}

// The version the layout engine placed, which the owner's edits started from:
// back through every earlier owner edit and going back (each copies or edits
// the one before, keeping the item ids). The engine's boxes are read from it.
async function enginePlaced(rows: VersionRows, from: StoredVersion): Promise<StoredVersion> {
  let at = from;
  for (let hop = 0; hop < CHAIN_MAX; hop += 1) {
    const before = at.edited_from_id ?? at.restored_from_id;
    if (!before) return at;
    const row = await rows.get(before);
    if (!row || row.reel_id !== from.reel_id) return at;
    at = row;
  }
  return at;
}

// An owner edit job's one step (no AI call): the added cards, the text edits
// and the moves applied to the version the owner edited, in that order, saved
// as a new version after the current one, marked as the owner's
// (`edited_from_id`). Nothing but the moved components' place and size and the
// edited elements' own text changes: a text edit never touches another
// element, a time or a spoken word (`applyOwnerTexts`), and its learning
// record goes to `owner_texts` in the same transaction. The owner's one hard rule is the safe zone: a move that leaves
// it, an id that is no text component, or a save that moves nothing is a
// permanent failure, and no version is written. A moved big word's cut-out is
// decided again (the head reaches it or not) and its mask made when missing.
// One learning record per component moved goes to `owner_moves` with the
// version, in the same transaction (`save_version`). The version's AI record
// is copied under the new id, so a later re-layout finds the same answer.
export async function runOwnerEdit({
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
  ownerEdit,
  measurer = editMeasurer,
  newId = randomUUID,
  photos,
}: OwnerEditRun): Promise<void> {
  return runToolsStep(ctx, {
    name: STEP,
    async work(_tool, stepContext) {
      const reelId = reelOf(ctx.job);
      const preset = ISSEBYA_PRESET;
      const currentId = await rows.current(reelId);
      if (currentId === null) throw new PermanentError(`${STEP}: the reel has no current version`);
      const base = await rows.get(ownerEdit.versionId);
      if (!base || base.reel_id !== reelId) {
        throw new PermanentError(
          `${STEP}: version ${ownerEdit.versionId} is not a version of this reel`,
        );
      }
      const read = async (ref: EditRef) => {
        const key = cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
        const stored = await storage.get(key);
        if (!stored) throw new Error(`${STEP}: input missing: ${key}`);
        return JSON.parse(new TextDecoder().decode(stored)) as unknown;
      };
      const transcript = transcriptSchema.parse(await read(base.inputs.transcript));
      const headTrack = headTrackSchema.parse(await read(base.inputs.head_track));
      const editOf = async (row: StoredVersion): Promise<Edit> => {
        const bytes = await blobs.get(row.r2_key);
        if (!bytes) throw new Error(`${STEP}: edit missing at ${row.r2_key}`);
        const parsed = parseEdit(JSON.parse(new TextDecoder().decode(bytes)), preset, transcript);
        if (!parsed.ok) {
          throw new PermanentError(
            `${STEP}: version ${row.number} does not parse: ${parsed.reasons.join("; ")}`,
          );
        }
        return parsed.edit;
      };
      const baseEdit = await editOf(base);
      const measure = await measurer(baseEdit.font_pair);
      const adds = ownerEdit.adds ?? [];
      // The photos a swap or an added card shows: the reel owner's, ready, with
      // a large copy and a size, read here (service role), never trusted from
      // the job. One that is not is a permanent failure.
      const photoIds = [
        ...new Set([
          ...ownerEdit.moves.flatMap((move) =>
            move.kind === "box" && move.photo_id ? [move.photo_id] : [],
          ),
          ...adds.map((add) => add.photo_id),
        ]),
      ];
      const library: OwnerPhotos =
        photoIds.length > 0 && photos
          ? await photos.readyPhotos(ctx.job.owner_id, photoIds)
          : new Map();
      const missing = photoIds.filter((id) => !library.has(id));
      if (missing.length > 0) {
        throw new PermanentError(
          `${STEP}: photo ${missing.join(", ")} is not a ready photo in the owner's library`,
        );
      }
      const context = { transcript, headTrack, preset, measurer: measure, photos: library };
      const engineRecord = base.engine_record ?? [];
      const componentsOf = (edit: Edit) =>
        build(edit, transcript, headTrack, preset, measure, { layer: "front", engineRecord })
          .components;

      // The added cards first (a later move may move one), then the moves
      // that change something; the safe zone is a text's one rule, a card's
      // is to keep a fifth of it in the frame.
      const baseComponents = componentsOf(baseEdit);
      const added = applyOwnerAdds(baseEdit, adds, context);
      if (!added.ok) {
        throw new PermanentError(`${STEP}: the cards are refused: ${added.reasons.join("; ")}`);
      }
      // The text edits that change a text, each on its own element: the limits
      // are measured against the edited version's own text.
      const texts = effectiveTexts(ownerEdit.texts ?? [], added.edit, context);
      const texted = applyOwnerTexts(added.edit, texts, context);
      if (!texted.ok) {
        throw new PermanentError(`${STEP}: the texts are refused: ${texted.reasons.join("; ")}`);
      }
      // A move of an element whose text changed always counts: its box is no
      // longer the version's.
      const textIds = new Set(texts.map((text) => text.id));
      const moves = [
        ...effectiveMoves(
          ownerEdit.moves.filter((move) => !textIds.has(move.id)),
          baseComponents,
        ),
        ...ownerEdit.moves.filter((move) => textIds.has(move.id)),
      ];
      if (moves.length === 0 && adds.length === 0 && texts.length === 0) {
        throw new PermanentError(`${STEP}: nothing was moved, resized or edited`);
      }
      const ids = [...new Set([...adds.map((add) => add.id), ...moves.map((move) => move.id)])];
      const applied = applyOwnerMoves(texted.edit, moves, context);
      if (!applied.ok) {
        throw new PermanentError(`${STEP}: the moves are refused: ${applied.reasons.join("; ")}`);
      }
      // A big word's cut-out is decided again when it moved or its text changed
      // (another width can bring it under the head).
      const moved = withMasks(
        withOwnerCutouts(applied.edit, [...new Set([...ids, ...textIds])], context),
        transcript,
        headTrack,
      );
      const built = build(moved, transcript, headTrack, preset, measure, { engineRecord });
      // An edited text is bound to the safe zone like a moved one.
      const problems = ownerMoveProblems(built.components, [...new Set([...ids, ...textIds])]);
      if (problems.length > 0) {
        throw new PermanentError(`${STEP}: the moves are refused: ${problems.join("; ")}`);
      }

      // Where the engine placed each moved component: the engine-placed version
      // the edits started from (the edited version itself unless it is an
      // earlier owner edit or a going back).
      const engineVersion = await enginePlaced(rows, base);
      const engineComponents =
        engineVersion.id === base.id ? baseComponents : componentsOf(await editOf(engineVersion));
      const records = ownerMoveRecords({
        ids,
        moves,
        engine: engineComponents,
        before: baseComponents,
        photos: library,
        transcript,
        owner: built.components,
        edit: moved,
        headTrack,
        preset,
        engineRecord: engineVersion.engine_record ?? engineRecord,
      }).map((record) => ({ ...record, engine_version_id: engineVersion.id }));
      const textRecords = ownerTextRecords({
        texts,
        before: { edit: baseEdit, components: baseComponents },
        after: { edit: moved, components: built.components },
        transcript,
        preset,
        engineRecord: engineVersion.engine_record ?? engineRecord,
      });

      const edit = await ensureCutouts({
        ctx,
        storage,
        keyPrefix,
        scratchDir,
        edit: moved,
        transcript,
        headTrack,
        tools,
        spawnTool,
        env,
        recordStored,
        parent: stepContext,
      });
      ctx.signal.throwIfAborted();

      // The AI record first, under the new version's id, a copy of the edited
      // version's: the answer is the same, only the owner's layout differs.
      const versionId = newId();
      const recordBytes = await storage.get(aiRecordKey(keyPrefix, reelId, base.id));
      const record = recordBytes
        ? (JSON.parse(new TextDecoder().decode(recordBytes)) as AiRecord)
        : null;
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
          editedFromId: base.id,
          ownerMoves: records,
          ownerTexts: textRecords,
          request: null,
          // No AI call was made: no model.
          model: null,
          promptVersion: record?.prompt_version ?? null,
          changeTitle: null,
          changeSummary: null,
          checks: built.checks,
          usedFreeField: usedFreeField(edit),
          unexpressed: [],
          freeField: [],
          rejectedReasons: [],
          // How the engine placed the version; the owner's moves are in
          // `owner_moves`.
          engineRecord: [...engineRecord],
          checklist: [],
          edit,
        },
      );
      const count = `${ids.length} component${ids.length === 1 ? "" : "s"}`;
      const edited =
        texts.length === 0
          ? ""
          : ` and ${texts.length} text${texts.length === 1 ? "" : "s"} edited`;
      return {
        what: `version ${saved.number}: ${count} moved${edited} by the owner, from version ${base.number}`,
        ai: NO_USAGE,
      };
    },
  });
}
