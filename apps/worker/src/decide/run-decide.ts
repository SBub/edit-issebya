import { randomUUID } from "node:crypto";
import { type Context, trace } from "@opentelemetry/api";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type DecideAnswer,
  type DecideRules,
  type Edit,
  type EditRef,
  ISSEBYA_PRESET,
  type Measurer,
  applyBehindRules,
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
import { ensureCutouts } from "../cutout/ensure-cutouts.ts";
import { withMasks } from "../cutout/spans.ts";
import { editMeasurer } from "../edit-measurer.ts";
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
  // For the cut-out a behind item needs before the version is saved.
  tools?: ToolPaths;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  recordStored?: (key: string, bytes: number) => Promise<void>;
}

// A refused attempt carries its reasons (the tail's lines) and the names of
// the rules it failed (data for the job and error tracking, never free text).
type Attempt =
  | { ok: true; edit: Edit; answer: DecideAnswer; reasons: [] }
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

// The pipeline's one AI step: Claude Code starts from the current version and
// answers with new tracks matching a JSON Schema made for this reel. The
// answer is checked again by Zod, built, run through the layout checks and
// the glossary check. A refused answer goes back once with its reasons; a
// second refusal fails the step with both rounds' reasons and writes nothing,
// so the current version stays. A passing answer becomes a new version, once
// the masks its behind items need are stored (the `cutout` step); a failed
// cut-out saves nothing.
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
      const forbid = rules ? await rules.read(reelId) : { photos: false, bigWord: false };
      const decideRules: DecideRules = { requested: request !== null, forbid };
      // Photos switched off and no request that could lift it: none offered.
      const photosOff = forbid.photos && request === null;
      const library = photos && !photosOff ? await photos.readyPhotos(ctx.job.owner_id) : [];
      const photoIds = library.map((photo) => photo.id);
      const schema = decideJsonSchema(preset, transcript, current.duration, photoIds, decideRules);
      const input = decideInput({
        current,
        transcript,
        headTrack,
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
            current.duration,
            photoIds,
            decideRules,
          );
          if (!answer.ok) return { ok: false, reasons: answer.reasons, rules: ["answer-schema"] };
          const composed = editFromAnswer(current, answer.answer, preset, transcript);
          if (!composed.ok) return { ok: false, reasons: composed.reasons, rules: ["answer-edit"] };
          // Built with the masks it will name: their fingerprints are known
          // before any is made.
          const checks = [
            ...build(withMasks(composed.edit, transcript), transcript, headTrack, preset, measure)
              .checks,
            ...glossaryChecks(composed.edit, transcript, preset),
          ];
          if (checks.length > 0) {
            return {
              ok: false,
              reasons: checks.map((check) => `${check.rule} ${check.item}: ${check.reason}`),
              rules: checks.map((check) => check.rule),
            };
          }
          return { ok: true, edit: composed.edit, answer: answer.answer, reasons: [] };
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
        const { answer } = passed;
        // The masks first: a version is saved (and so shown) only once they
        // exist. A failure here comes after the AI call, so it is permanent.
        const edit = await ensureCutouts({
          ctx,
          storage,
          keyPrefix,
          scratchDir,
          edit: passed.edit,
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
            // The passing build's checks: none failed.
            checks: [],
            usedFreeField: usedFreeField(edit) || answer.free_field.length > 0,
            unexpressed: answer.unexpressed,
            freeField: answer.free_field,
            rejectedReasons: first.ok ? [] : first.reasons,
            forbid: {
              photos: answer.behind_rules.photos === "keep" ? null : after.photos,
              bigWord: answer.behind_rules.big_word === "keep" ? null : after.bigWord,
            },
            edit,
          },
        ).catch(permanentAfterAiCall);
        trace.getSpan(stepContext)?.setAttribute("reel.tracks_items", trackItems(edit));
        const counts = decideCounts(edit, transcript, preset);
        const what = [
          `version ${saved.number}: ${plural(counts.accents, "accent")}`,
          plural(counts.transitions, "transition"),
          counts.title ? "title set" : "no title",
          `${plural(counts.wordsFixed, "word")} fixed`,
          ...(counts.behindPhotos + counts.behindWords > 0
            ? [`${counts.behindPhotos + counts.behindWords} behind`]
            : []),
        ].join(", ");
        return { what, ai: usage };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  });
}
