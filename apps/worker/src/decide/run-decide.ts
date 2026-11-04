import { randomUUID } from "node:crypto";
import { type Context, trace } from "@opentelemetry/api";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type Check,
  type DecideAnswer,
  type DecideRules,
  type Edit,
  type EngineNote,
  type EditRef,
  ISSEBYA_PRESET,
  type Measurer,
  applyBehindRules,
  backgroundSampler,
  checklistOutcome,
  type VersionBlobs,
  type VersionRows,
  build,
  decideCounts,
  decideJsonSchema,
  editFromAnswer,
  glossaryChecks,
  headTrackSchema,
  parseDecideAnswer,
  parseEdit,
  saveVersion,
  transcriptSchema,
  usedFreeField,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import type { AiRunner } from "../ai.ts";
import { ensureBackgrounds } from "../backgrounds/ensure-backgrounds.ts";
import { ensureCutouts } from "../cutout/ensure-cutouts.ts";
import { withMasks } from "../cutout/spans.ts";
import { editMeasurer } from "../edit-measurer.ts";
import { engineRecordLine } from "../engine-record.ts";
import { AiUnavailable, AnswerRefused, permanentAfterAiCall } from "../failure.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { type ToolPaths, toolPaths } from "../pipeline/tools.ts";
import type { PhotoLibrary } from "../photos/photo-store.ts";
import { reelOf } from "../queue.ts";
import {
  type SpawnTool,
  type StepContext,
  StepError,
  type Tool,
  runToolsStep,
} from "../step-runner.ts";
import { type AiUsage, addUsage } from "../step-store.ts";
import type { ReelRules } from "./behind-rules.ts";
import { type Placed, runEditorialRounds } from "./editorial.ts";
import { decideInput } from "./input.ts";
import { PROMPT_VERSION, decidePrompt } from "./prompt.ts";

export const STEP = "decide";
// Reason lines per round in the failure tail (the "and k more" line
// included), so the heading and both rounds fit its 20 lines.
const LINES_PER_ROUND = 8;

export interface DecideRun {
  ctx: StepContext;
  storage: Storage;
  rows: VersionRows;
  blobs: VersionBlobs;
  keyPrefix: string;
  ai: AiRunner;
  scratchDir: string;
  // The owner's request; null for the automatic decide after version 1.
  request?: string | null;
  measurer?: () => Promise<Measurer>;
  newId?: () => string;
  // The owner's ready photos, offered for the behind track; none without it.
  photos?: PhotoLibrary;
  // The reel's behind rules ("no photos in this one"); none: nothing forbidden.
  rules?: ReelRules;
  // For the cut-out a behind item needs before the version is saved, and the
  // footage's background map the engine keeps the text readable over.
  tools?: ToolPaths;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  recordStored?: (key: string, bytes: number) => Promise<void>;
  // Where the engine record and a layout check the engine broke are logged.
  log?: (line: string) => void;
}

// A refused attempt carries its reasons (the tail's lines) and the names of
// the rules it failed (data for the job and error tracking, never free text).
// A placed one carries the engine's record and the layout checks of its build.
type Attempt =
  | {
      ok: true;
      edit: Edit;
      answer: DecideAnswer;
      record: EngineNote[];
      placed: Placed;
      checks: Check[];
      reasons: [];
    }
  | { ok: false; reasons: string[]; rules: string[] };

// The number of items over every track of an edit (`reel.tracks_items`).
function trackItems(edit: Edit): number {
  let count = 0;
  for (const items of Object.values(edit.tracks)) {
    if (Array.isArray(items)) count += items.length;
  }
  return count;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function roundLines(round: number, reasons: readonly string[]): string[] {
  if (reasons.length <= LINES_PER_ROUND) {
    return [`round ${round}:`, ...reasons.map((reason) => `- ${reason}`)];
  }
  const shown = reasons.slice(0, LINES_PER_ROUND - 1).map((reason) => `- ${reason}`);
  return [`round ${round}:`, ...shown, `- and ${reasons.length - shown.length} more`];
}

// The pipeline's one AI step: Claude Code starts from the current version's
// choices and answers in meaning only (word ids, photo ids, wishes) with a
// JSON Schema made for this reel. The answer is checked again by Zod and the
// glossary check; only an answer breaking those is refused. It goes back once
// with its reasons; a second refusal fails the step with both rounds' reasons
// and writes nothing, so the current version stays. Layout never refuses an
// answer: the layout engine (`editFromAnswer`) places every item, dropping
// what fits nowhere into its record, and the layout checks are its final
// guard. A check failing on the engine's output is an engine bug: it is
// logged with the reel id and stored on the row, and the version is still
// saved. A placed answer becomes a new version, once the masks its behind
// items need are stored (the `cutout` step); a failed cut-out saves nothing.
// The engine record is saved with the version and logged in one line.
// Never cached: a retried job decides again from the then-current version.
export function runDecide({
  ctx,
  storage,
  rows,
  blobs,
  keyPrefix,
  ai,
  scratchDir,
  request = null,
  measurer = editMeasurer,
  newId = randomUUID,
  photos,
  rules,
  tools = toolPaths(),
  spawnTool,
  env = process.env,
  recordStored,
  log = console.log,
}: DecideRun): Promise<void> {
  const preset = ISSEBYA_PRESET;
  return runToolsStep(ctx, {
    name: STEP,
    async work(tool: Tool, stepContext: Context) {
      const reelId = reelOf(ctx.job);
      const currentId = await rows.current(reelId);
      if (currentId === null) throw new Error(`${STEP}: no current version`);
      const row = await rows.get(currentId);
      if (!row) throw new Error(`${STEP}: current version ${currentId} not found`);
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
      const parsed = parseEdit(JSON.parse(new TextDecoder().decode(bytes)), preset, transcript);
      if (!parsed.ok) {
        throw new Error(`${STEP}: current version does not parse: ${parsed.reasons.join("; ")}`);
      }
      const current = parsed.edit;
      // Before the AI call, so a failure here is an ordinary step failure.
      const backgrounds = backgroundSampler(
        await ensureBackgrounds({
          ctx,
          storage,
          keyPrefix,
          scratchDir,
          footage: row.inputs.footage,
          tools,
          spawnTool,
          recordStored,
        }),
        preset.frame,
      );
      const forbid = rules ? await rules.read(reelId) : { photos: false, bigWord: false };
      const decideRules: DecideRules = { requested: request !== null, forbid };
      // Photos switched off and no request that could lift it: none offered.
      const photosOff = forbid.photos && request === null;
      const library = photos && !photosOff ? await photos.readyPhotos(ctx.job.owner_id) : [];
      const photoIds = library.map((photo) => photo.id);
      const schema = decideJsonSchema(preset, transcript, photoIds, decideRules);
      const input = decideInput({
        current,
        transcript,
        preset,
        library,
        forbid,
        request,
      });
      const measure = await measurer();

      let usage: AiUsage = { inputTokens: null, outputTokens: null, costUsd: null, model: null };
      const cwd = await mkdtemp(join(scratchDir, "decide-"));
      try {
        const attempt = async (previous?: string[]): Promise<Attempt> => {
          const result = await ai.call(tool, {
            prompt: decidePrompt(input, previous),
            schema,
            cwd,
          });
          usage = addUsage(usage, result.usage);
          // Not available now: the job waits, nothing is written.
          if (result.kind === "unavailable") throw new AiUnavailable(result.reason);
          if (result.kind === "broken") {
            return {
              ok: false,
              reasons: [`the answer was not valid JSON: ${result.reason}`],
              rules: ["answer-json"],
            };
          }
          const answer = parseDecideAnswer(
            result.answer,
            preset,
            transcript,
            photoIds,
            decideRules,
          );
          if (!answer.ok) return { ok: false, reasons: answer.reasons, rules: ["answer-schema"] };
          // Meaning only: the layout engine places the answer's words.
          const composed = editFromAnswer(
            current,
            answer.answer,
            preset,
            transcript,
            headTrack,
            measure,
            backgrounds,
          );
          if (!composed.ok) return { ok: false, reasons: composed.reasons, rules: ["answer-edit"] };
          // What the answer wrote: a fix showing a glossary word's heard form.
          const glossary = glossaryChecks(composed.edit, transcript, preset);
          if (glossary.length > 0) {
            return {
              ok: false,
              reasons: glossary.map((check) => `${check.rule} ${check.item}: ${check.reason}`),
              rules: glossary.map((check) => check.rule),
            };
          }
          // Built with the masks it will name: their fingerprints are known
          // before any is made.
          const { checks } = build(
            withMasks(composed.edit, transcript),
            transcript,
            headTrack,
            preset,
            measure,
          );
          return {
            ok: true,
            edit: composed.edit,
            answer: answer.answer,
            record: composed.record,
            placed: {
              edit: composed.edit,
              record: composed.record,
              unplaced: composed.unplaced,
              free: composed.free,
            },
            checks,
            reasons: [],
          };
        };

        // Exactly one retry, never a loop.
        const first = await attempt().catch(permanentAfterAiCall);
        const passed = first.ok ? first : await attempt(first.reasons).catch(permanentAfterAiCall);
        if (!passed.ok) {
          const tail = [
            `${STEP}: the answer failed twice, version ${row.number} stays current`,
            ...roundLines(1, first.reasons),
            ...roundLines(2, passed.reasons),
          ].join("\n");
          const firstRules = first.ok ? [] : first.rules;
          const failed = [...new Set([...firstRules, ...passed.rules])].sort();
          throw new StepError(tail, tail, usage, { cause: new AnswerRefused(failed, 2) });
        }

        ctx.signal.throwIfAborted();
        // The editorial round: what the engine left out goes back to the
        // editor for another meaning choice, and the whole answer is placed
        // again. A refused editorial answer only ends the rounds.
        const editorial = await runEditorialRounds({
          ai,
          tool,
          cwd,
          transcript,
          preset,
          library,
          photoIds,
          request,
          check: (json) => parseDecideAnswer(json, preset, transcript, photoIds, decideRules),
          place: (merged) => {
            const composed = editFromAnswer(
              current,
              merged,
              preset,
              transcript,
              headTrack,
              measure,
              backgrounds,
            );
            if (!composed.ok) {
              log(`${STEP}: engine bug, reel ${reelId}: ${composed.reasons.join("; ")}`);
              return null;
            }
            return {
              edit: composed.edit,
              record: composed.record,
              unplaced: composed.unplaced,
              free: composed.free,
            };
          },
          answer: passed.answer,
          placed: passed.placed,
        }).catch(permanentAfterAiCall);
        usage = addUsage(usage, editorial.usage);
        if (editorial.ended)
          log(`${STEP}: editorial round ended, reel ${reelId}: ${editorial.ended}`);
        ctx.signal.throwIfAborted();
        const { answer } = editorial;
        const final = editorial.placed;
        const record = [...final.record, ...editorial.notes];
        const checks =
          editorial.placed === passed.placed
            ? passed.checks
            : build(withMasks(final.edit, transcript), transcript, headTrack, preset, measure)
                .checks;
        // The engine's only allowed face covering: captions it put over the
        // face because nothing else was free, and an item the owner asked for
        // it let cover the face as its last step, each said so in its record.
        const coversFace = new Set(
          record.filter((note) => note.action === "covers-face").map((note) => note.item),
        );
        const madeRoom = new Set(
          record
            .filter((note) => note.action === "covers-face" && note.rule === "make-room")
            .map((note) => note.item),
        );
        const broken = checks.filter(
          (check) =>
            !(check.rule === "face" && coversFace.has(check.item)) &&
            !(check.rule === "behind-face" && madeRoom.has(check.item)),
        );
        if (broken.length > 0) {
          log(
            `${STEP}: engine bug, reel ${reelId}: ${broken.map((check) => `${check.rule} ${check.item}: ${check.reason}`).join("; ")}`,
          );
        }
        // The masks first: a version is saved (and so shown) only once they
        // exist. A failure here comes after the AI call, so it is permanent.
        const edit = await ensureCutouts({
          ctx,
          storage,
          keyPrefix,
          scratchDir,
          edit: final.edit,
          transcript,
          photoIds,
          tools,
          spawnTool,
          env,
          recordStored,
        }).catch(permanentAfterAiCall);
        ctx.signal.throwIfAborted();
        // The forbids this answer sets or lifts, written with its version;
        // null where it keeps the stored flag.
        const after = applyBehindRules(forbid, answer.behind_rules);
        const saved = await saveVersion(
          { rows, blobs, keyPrefix, newId },
          {
            reelId,
            parentId: currentId,
            restoredFromId: null,
            request,
            model: usage.model,
            promptVersion: PROMPT_VERSION,
            changeTitle: answer.change_title,
            changeSummary: answer.change_summary,
            // The engine's build checks: empty unless the engine broke a rule.
            checks,
            // The answer has no free style field; a kept item may still carry one.
            usedFreeField: usedFreeField(edit),
            unexpressed: answer.unexpressed,
            freeField: [],
            rejectedReasons: first.ok ? [] : first.reasons,
            engineRecord: record,
            checklist: checklistOutcome(answer.checklist, final),
            forbid: {
              photos: answer.behind_rules.photos === "keep" ? null : after.photos,
              bigWord: answer.behind_rules.big_word === "keep" ? null : after.bigWord,
            },
            edit,
          },
        ).catch(permanentAfterAiCall);
        log(engineRecordLine(reelId, saved.number, record));
        trace.getSpan(stepContext)?.setAttribute("reel.tracks_items", trackItems(edit));
        const counts = decideCounts(edit, transcript, preset);
        const dropped = final.record.filter((note) => note.action === "dropped").length;
        const what = [
          `version ${saved.number}: ${plural(counts.accents, "accent")}`,
          plural(counts.transitions, "transition"),
          counts.title ? "title set" : "no title",
          `${plural(counts.wordsFixed, "word")} fixed`,
          ...(counts.behindPhotos + counts.behindWords > 0
            ? [`${counts.behindPhotos + counts.behindWords} behind`]
            : []),
          ...(dropped > 0 ? [`${dropped} dropped`] : []),
          ...(editorial.rounds > 0 ? [plural(editorial.rounds, "editorial round")] : []),
        ].join(", ");
        return { what, ai: usage };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  });
}
