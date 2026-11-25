import { randomUUID } from "node:crypto";
import { type Context, trace } from "@opentelemetry/api";
import {
  type Check,
  type DecideAnswer,
  type Edit,
  type EngineInput,
  type EngineNote,
  type EditRef,
  ISSEBYA_PRESET,
  type Measurer,
  type Preset,
  type StoredCorrection,
  type VersionBlobs,
  type VersionRows,
  COMPONENTS,
  applyWordCorrections,
  build,
  correctedTranscript,
  decideCounts,
  decideJsonSchema,
  editFromAnswer,
  headTrackSchema,
  keepOwnerAdds,
  liveCorrections,
  parseDecideAnswer,
  parseEdit,
  saveVersion,
  transcriptSchema,
  usedFreeField,
  withWordCorrections,
  type FontPairId,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { type AiRunner, NO_USAGE } from "../ai.ts";
import { ensureCutouts } from "../cutout/ensure-cutouts.ts";
import { withMasks } from "../cutout/spans.ts";
import { editMeasurer } from "../edit-measurer.ts";
import { engineRecordLine } from "../engine-record.ts";
import { AiUnavailable, AnswerRefused, permanentAfterAiCall } from "../failure.ts";
import { type PromptSource, decidePrompts, promptIdentity } from "../prompts/source.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { type ToolPaths, toolPaths } from "../pipeline/tools.ts";
import { reelOf } from "../queue.ts";
import { inSpan } from "../telemetry.ts";
import {
  type SpawnTool,
  type StepContext,
  StepError,
  type Tool,
  runToolsStep,
} from "../step-runner.ts";
import { type AiUsage, addUsage } from "../step-store.ts";
import { type AiRecordCall, writeAiRecord } from "./ai-record.ts";
import { decideInput } from "./input.ts";
import { hookInput, hookPrompt } from "./hook.ts";
import { decidePrompt } from "./prompt.ts";

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
  // The worker's prompt source: the two decide prompts are fetched at the
  // start of the step (before any AI call).
  prompts: PromptSource;
  scratchDir: string;
  // Start over (temporary, for testing): the version to decide from instead
  // of the current one (the reel's version 1); the new version's parent is
  // still the current one. Null or absent: from the current version.
  startFrom?: string | null;
  // The reel owner's font pair (`font-pair-store.ts`), read when the step starts.
  ownerFontPair: () => Promise<FontPairId>;
  // The reel's transcript corrections (`word-corrections-store.ts`), read when
  // the step starts: the AI reads the transcript with them and the engine
  // writes them. None by default.
  corrections?: () => Promise<StoredCorrection[]>;
  measurer?: (pair: FontPairId) => Promise<Measurer>;
  newId?: () => string;
  // For the cut-out a behind item needs before the version is saved.
  tools?: ToolPaths;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  recordStored?: (key: string, bytes: number) => Promise<void>;
  // Where the engine record and a layout check the engine broke are logged.
  log?: (line: string) => void;
  // The preset the reel is placed with (the worker's by default).
  preset?: Preset;
}

// A refused attempt carries its reasons (the tail's lines) and the names of
// the rules it failed (data for the job and error tracking, never free text).
// A placed one carries the engine's edit, its record and the layout checks of
// its build.
type Attempt =
  | {
      ok: true;
      edit: Edit;
      record: EngineNote[];
      checks: Check[];
      // The owner's transcript corrections shown, and those that could not be.
      corrected: { kept: number; dropped: number };
      reasons: [];
    }
  | { ok: false; reasons: string[]; rules: string[] };

// One hook call's outcome: the text, or the reasons it is refused.
type HookAttempt = { ok: true; text: string } | { ok: false; reasons: string[]; rules: string[] };

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

// The pipeline's AI step, two calls before the layout: first the written hook
// (role `hook`, prompt `reel-hook`), the one text the reel opens with, then the
// components (role `decide`), which see the reel's script, the hook as data and
// the target count (both calls read the transcript with the owner's
// corrections, `owner-corrections.ts`), and answer in meaning only (word ids) with a JSON Schema
// made for this reel. Each answer is checked again by Zod and by the layout
// engine's placement; only an answer breaking those is refused. Each goes
// back once with its reasons; a second refusal of either fails the step with
// the reasons and writes nothing, so the current version stays. Layout never
// refuses an answer: the layout engine (`editFromAnswer`) places every item,
// the hook first, dropping what fits nowhere into its record, and the layout
// checks are its final guard. Nothing asks Claude again about what the engine
// left out: the components' answer is the one meaning the engine places.
// A check failing on the engine's output is an engine bug: it is
// logged with the reel id and stored on the row, and the version is still
// saved. A placed answer becomes a new version, once the masks its behind
// items need are stored (the `cutout` step); a failed cut-out saves nothing.
// The engine record is saved with the version and logged in one line; every
// AI call's prompt and raw answer is stored beside it (`ai-record.ts`).
// Never cached: a retried job decides again from the then-current version.
export function runDecide({
  preset = ISSEBYA_PRESET,
  ctx,
  storage,
  rows,
  blobs,
  keyPrefix,
  ai,
  prompts,
  scratchDir,
  startFrom = null,
  ownerFontPair,
  corrections = () => Promise.resolve([]),
  measurer = editMeasurer,
  newId = randomUUID,
  tools = toolPaths(),
  spawnTool,
  env = process.env,
  recordStored,
  log = console.log,
}: DecideRun): Promise<void> {
  return runToolsStep(ctx, {
    name: STEP,
    async work(tool: Tool, stepContext: Context) {
      const reelId = reelOf(ctx.job);
      // The three prompts, before anything is read or called: a PostHog failure
      // is a transient step failure with no AI call made.
      const templates = await decidePrompts(prompts);
      // The current version and the inputs it reads (the first stage).
      const loaded = await inSpan(ctx.telemetry, stepContext, "decide.load", {}, async () => {
        const currentId = await rows.current(reelId);
        if (currentId === null) throw new Error(`${STEP}: no current version`);
        const baseId = startFrom ?? currentId;
        const row = await rows.get(baseId);
        if (!row || row.reel_id !== reelId) {
          throw new Error(`${STEP}: version ${baseId} of this reel not found`);
        }
        // The version that stays current when nothing is saved.
        const currentNumber =
          baseId === currentId ? row.number : ((await rows.get(currentId))?.number ?? "?");
        const bytes = await blobs.get(row.r2_key);
        if (!bytes) throw new Error(`${STEP}: edit missing at ${row.r2_key}`);

        const read = async (ref: EditRef) => {
          const key = cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
          const stored = await storage.get(key);
          if (!stored) throw new Error(`${STEP}: input missing: ${key}`);
          return JSON.parse(new TextDecoder().decode(stored)) as unknown;
        };
        // The owner's pair: the new version is set in it, whatever pair the version it decides from is in.
        const fontPair = await ownerFontPair();
        const transcript = transcriptSchema.parse(await read(row.inputs.transcript));
        const headTrack = headTrackSchema.parse(await read(row.inputs.head_track));
        const parsed = parseEdit(JSON.parse(new TextDecoder().decode(bytes)), preset, transcript);
        if (!parsed.ok) {
          throw new Error(`${STEP}: current version does not parse: ${parsed.reasons.join("; ")}`);
        }
        // A Start over decides from version 1, while the reel's current
        // version may hold cards the owner added: read here, kept on the new
        // answer's placement below. Nothing else of the owner's version goes
        // with a Start over.
        let ownerWork: Edit | null = null;
        if (baseId !== currentId) {
          const currentRow = await rows.get(currentId);
          const currentBytes = currentRow ? await blobs.get(currentRow.r2_key) : null;
          const owned = currentBytes
            ? parseEdit(JSON.parse(new TextDecoder().decode(currentBytes)), preset, transcript)
            : null;
          if (owned?.ok) ownerWork = owned.edit;
        }
        // The owner's corrections that hold for this transcript: every decide
        // builds from the transcript with them.
        const fixes = liveCorrections(await corrections(), transcript);
        return {
          currentId,
          currentNumber,
          row,
          transcript,
          headTrack,
          current: { ...parsed.edit, font_pair: fontPair },
          ownerWork,
          fixes,
        };
      });
      const { currentId, currentNumber, row, transcript, headTrack, current, ownerWork, fixes } =
        loaded;
      // The transcript as the AI reads it: the owner's words in place of the
      // corrected ones.
      const spoken = correctedTranscript(transcript, fixes);
      const prepared = await inSpan(ctx.telemetry, stepContext, "decide.prepare", {}, async () => {
        const schema = decideJsonSchema(preset, transcript);
        return {
          schema,
          measure: await measurer(current.font_pair),
        };
      });
      const { schema, measure } = prepared;

      let usage: AiUsage = NO_USAGE;
      // Every call as sent and answered, for the version's AI record: the hook
      // calls first, then the decide attempts.
      const calls: AiRecordCall[] = [];
      // The written hook: its own call, before the components. Its answer is
      // refused only by its schema, and it goes back once; a
      // second refusal fails the step, so no reel is saved without a hook.
      const hookSource = hookInput(spoken, preset);
      const hookCall = COMPONENTS.HOOK.ownCall;
      const hookSchema = hookCall.schema(preset);
      const hookOnce = async (context: Context, previous?: string[]): Promise<HookAttempt> => {
        const result = await ai.call({
          role: hookCall.role,
          ...hookPrompt(templates.hook, hookSource, previous),
          schema: hookSchema,
          signal: ctx.signal,
          trace: { telemetry: ctx.telemetry, parent: context },
        });
        usage = addUsage(usage, result.usage);
        calls.push({ attempt: previous ? 2 : 1, ...result.exchange });
        if (result.kind === "unavailable") throw new AiUnavailable(result.reason);
        if (result.kind === "broken") {
          return {
            ok: false,
            reasons: [`the answer was not valid JSON: ${result.reason}`],
            rules: ["answer-json"],
          };
        }
        const parsed = hookCall.parse(result.answer, preset);
        if (!parsed.ok) return { ok: false, reasons: parsed.reasons, rules: ["answer-schema"] };
        return { ok: true, text: parsed.text };
      };
      // Each hook call is a `decide.hook` span with its `chat` span under it.
      const hookAttempt = (number: 1 | 2, previous?: string[]): Promise<HookAttempt> =>
        inSpan(
          ctx.telemetry,
          stepContext,
          "decide.hook",
          { "decide.attempt": number },
          async (span, context) => {
            const made = await hookOnce(context, previous);
            span.setAttribute("decide.outcome", made.ok ? "ok" : "refused");
            if (!made.ok) span.setAttribute("decide.refused_by", made.rules.join(","));
            return made;
          },
        );
      const firstHook = await hookAttempt(1).catch(permanentAfterAiCall);
      const writtenHook = firstHook.ok
        ? firstHook
        : await hookAttempt(2, firstHook.reasons).catch(permanentAfterAiCall);
      if (!writtenHook.ok) {
        const tail = [
          `${STEP}: the hook failed twice, version ${currentNumber} stays current`,
          ...roundLines(1, firstHook.ok ? [] : firstHook.reasons),
          ...roundLines(2, writtenHook.reasons),
        ].join("\n");
        const failed = [
          ...new Set([...(firstHook.ok ? [] : firstHook.rules), ...writtenHook.rules]),
        ].sort();
        throw new StepError(tail, tail, usage, { cause: new AnswerRefused(failed, 2) });
      }
      const hookText = writtenHook.text;
      // The components' prompt: the script, the hook as data and the target.
      const input = decideInput({
        transcript: spoken,
        preset,
        hook: { text: hookText },
      });
      // The components' answer with the hook beside it: the layout engine's
      // input (the components are placed by start time, see `placeEdit`).
      const engineAnswer = (components: DecideAnswer): EngineInput => ({
        ...components,
        hook: { text: hookText },
      });
      // One call and its placement. The call is a `chat` span under the
      // attempt's span; the layout engine's work is a `decide.engine` span
      // under the attempt too.
      const answerOnce = async (context: Context, previous?: string[]): Promise<Attempt> => {
        const result = await ai.call({
          role: "decide",
          ...decidePrompt(templates.components, input, previous),
          schema,
          signal: ctx.signal,
          trace: { telemetry: ctx.telemetry, parent: context },
        });
        usage = addUsage(usage, result.usage);
        calls.push({ attempt: previous ? 2 : 1, ...result.exchange });
        // Not available now: the job waits, nothing is written.
        if (result.kind === "unavailable") throw new AiUnavailable(result.reason);
        if (result.kind === "broken") {
          return {
            ok: false,
            reasons: [`the answer was not valid JSON: ${result.reason}`],
            rules: ["answer-json"],
          };
        }
        const answer = parseDecideAnswer(result.answer, preset, transcript);
        if (!answer.ok) return { ok: false, reasons: answer.reasons, rules: ["answer-schema"] };
        return inSpan(
          ctx.telemetry,
          context,
          "decide.engine",
          {},
          async (engine): Promise<Attempt> => {
            // Meaning only: the layout engine places the answer's words, the
            // owner's corrections over the transcript's and the curator's.
            const composed = editFromAnswer(
              current,
              withWordCorrections(engineAnswer(answer.answer), fixes),
              preset,
              transcript,
              headTrack,
              measure,
            );
            if (!composed.ok) {
              return { ok: false, reasons: composed.reasons, rules: ["answer-edit"] };
            }
            // A caption the owner typed over several spoken words is one
            // caption again, and the corrected captions are marked as hers.
            const corrected = applyWordCorrections(composed.edit, fixes, {
              transcript,
              headTrack,
              preset,
              measurer: measure,
            });
            const record = [...composed.record, ...corrected.notes];
            // Built with the masks it will name: their fingerprints are known
            // before any is made.
            const { checks } = build(
              withMasks(corrected.edit, transcript, headTrack),
              transcript,
              headTrack,
              preset,
              measure,
              { engineRecord: record },
            );
            engine.setAttribute("decide.checks", checks.length);
            return {
              ok: true,
              edit: corrected.edit,
              record,
              checks,
              corrected: { kept: corrected.kept, dropped: corrected.dropped },
              reasons: [],
            };
          },
        );
      };
      // Each attempt is a `decide.attempt` span with its number, its
      // outcome and, when refused, the rules that refused it.
      const attempt = (number: 1 | 2, previous?: string[]): Promise<Attempt> =>
        inSpan(
          ctx.telemetry,
          stepContext,
          "decide.attempt",
          { "decide.attempt": number },
          async (span, context) => {
            const made = await answerOnce(context, previous);
            if (made.ok) {
              span.setAttribute("decide.outcome", "ok");
            } else {
              span.setAttributes({
                "decide.outcome": made.rules.includes("answer-json") ? "invalid" : "refused",
                "decide.refused_by": made.rules.join(","),
              });
            }
            return made;
          },
        );

      // Exactly one retry, never a loop.
      const first = await attempt(1).catch(permanentAfterAiCall);
      const passed = first.ok ? first : await attempt(2, first.reasons).catch(permanentAfterAiCall);
      if (!passed.ok) {
        const tail = [
          `${STEP}: the answer failed twice, version ${currentNumber} stays current`,
          ...roundLines(1, first.reasons),
          ...roundLines(2, passed.reasons),
        ].join("\n");
        const firstRules = first.ok ? [] : first.rules;
        const failed = [...new Set([...firstRules, ...passed.rules])].sort();
        throw new StepError(tail, tail, usage, { cause: new AnswerRefused(failed, 2) });
      }

      ctx.signal.throwIfAborted();
      // The placed answer: its edit, the engine's record and the layout checks
      // of its build (the engine's own output, never a second placement).
      // A Start over is a fresh answer: no place, size or element text of the
      // owner's version goes with it. Only the cards the owner added are kept
      // as they were (`keepOwnerAdds`), beside the transcript corrections the
      // placement already holds.
      let { edit: placed, checks } = passed;
      const { record } = passed;
      if (ownerWork) {
        const kept = keepOwnerAdds(ownerWork, placed, { transcript, preset });
        if (kept !== placed) {
          placed = kept;
          checks = build(
            withMasks(placed, transcript, headTrack),
            transcript,
            headTrack,
            preset,
            measure,
            { engineRecord: record },
          ).checks;
        }
      }
      // The engine's only allowed face covering: captions it put over the
      // face because nothing else was free, each said so in its record.
      const coversFace = new Set(
        record.filter((note) => note.outcome === "covers-face").map((note) => note.item),
      );
      const broken = checks.filter(
        (check) => !(check.rule === "face" && coversFace.has(check.item)),
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
        edit: placed,
        transcript,
        headTrack,
        tools,
        spawnTool,
        env,
        recordStored,
        parent: stepContext,
      }).catch(permanentAfterAiCall);
      ctx.signal.throwIfAborted();
      // The AI record first, under the new version's id: a version is never
      // saved without it.
      const versionId = newId();
      await writeAiRecord(storage, keyPrefix, {
        format: 1,
        reel_id: reelId,
        version_id: versionId,
        prompt_version: promptIdentity(templates.components),
        hook_prompt_version: promptIdentity(templates.hook),
        intensity: preset.intensity,
        target_picks: input.target_picks,
        calls,
      }).catch(permanentAfterAiCall);
      const saved = await inSpan(ctx.telemetry, stepContext, "decide.save_version", {}, () =>
        saveVersion(
          { rows, blobs, keyPrefix, newId: () => versionId },
          {
            reelId,
            parentId: currentId,
            restoredFromId: null,
            request: null,
            model: usage.model,
            promptVersion: promptIdentity(templates.components),
            // No title and no summary: a new version has no change box text.
            changeTitle: null,
            changeSummary: null,
            // The engine's build checks: empty unless the engine broke a rule.
            checks,
            // The answer has no free style field; a kept item may still carry one.
            usedFreeField: usedFreeField(edit),
            // A new answer asks for nothing: no unexpressed request, no checklist.
            unexpressed: [],
            freeField: [],
            rejectedReasons: first.ok ? [] : first.reasons,
            engineRecord: record,
            checklist: [],
            edit,
          },
        ),
      ).catch(permanentAfterAiCall);
      log(engineRecordLine(reelId, saved.number, record));
      trace.getSpan(stepContext)?.setAttribute("reel.tracks_items", trackItems(edit));
      const counts = decideCounts(edit, transcript, preset);
      const what = [
        `version ${saved.number}: ${plural(counts.accents, "accent")}`,
        ...(counts.questions > 0 ? [plural(counts.questions, "question")] : []),
        plural(counts.transitions, "transition"),
        ...(counts.hook ? ["hook set"] : []),
        `${plural(counts.wordsFixed, "word")} fixed`,
        ...(counts.behindVisuals + counts.behindWords > 0
          ? [`${counts.behindVisuals + counts.behindWords} behind`]
          : []),
        ...(startFrom !== null ? [`started over from version ${row.number}`] : []),
        ...(passed.corrected.kept > 0
          ? [`${plural(passed.corrected.kept, "word correction")} of yours kept`]
          : []),
        ...(passed.corrected.dropped > 0
          ? [`${plural(passed.corrected.dropped, "word correction")} of yours could not be kept`]
          : []),
      ].join(", ");
      return { what, ai: usage };
    },
  });
}
