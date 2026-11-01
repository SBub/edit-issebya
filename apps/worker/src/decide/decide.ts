import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type DecideContext,
  type HeadTrack,
  ISSEBYA,
  type Transcript,
  type VersionStore,
  answerCounts,
  createMeasurer,
  decideJsonSchema,
  parseEdit,
  saveVersion,
} from "@edit-issebya/edit";
import { type Storage, cacheKey } from "@edit-issebya/storage";
import { AiAnswerError, type AiRunner, aiRunner } from "../ai.ts";
import {
  type SpawnTool,
  type StepContext,
  StepTailError,
  type Tool,
  runToolsStep,
} from "../step-runner.ts";
import type { AiUsage } from "../step-store.ts";
import { fingerprintOf, fontBytes, leaseGuarded, readJson } from "../steps/version-io.ts";
import { type Attempt, evaluateAttempt } from "./attempt.ts";
import { PROMPT_VERSION, decidePrompt, retryPrompt } from "./prompt.ts";

const STEP = "decide";
// Per round in the error tail, so both rounds fit its 20 lines and 4096 bytes.
const MAX_REASONS = 8;
const MAX_REASON_CHARS = 200;

export interface DecideRun {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  scratchDir: string;
  // runPipeline's fingerprints, by step name.
  fingerprints: Record<string, string>;
  versions: VersionStore;
  // The only place outside the doctor that calls the AI.
  ai?: AiRunner;
  // The owner's change request; null for the process job's first edit.
  request?: string | null;
  // Tests pass a fixed id and a fake spawner.
  newId?: () => string;
  spawnTool?: SpawnTool;
}

function plural(count: number, unit: string, suffix = ""): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}${suffix}`;
}

function clip(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 3)}...` : reason;
}

function roundLine(round: number, reasons: string[]): string {
  const shown = reasons.slice(0, MAX_REASONS).map(clip);
  const more = reasons.length - shown.length;
  return `round ${round}: ${[...shown, ...(more > 0 ? [`and ${more} more`] : [])].join("; ")}`;
}

// The reel's one AI step: Claude Code turns the current version into a new
// one (fixed words, accents, transitions, a title) under a JSON Schema made
// for this reel. Every answer goes through the schema, the builder's checks
// and the glossary; a refused answer goes back once with the reasons, and a
// second refusal fails the step with both rounds in the error tail. Only a
// passing answer is saved, as a new current version recording how it was
// made. Never cached; a process job whose reel already has an AI version
// writes nothing.
export function decide({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  fingerprints,
  versions,
  ai = aiRunner(),
  request = null,
  newId = randomUUID,
  spawnTool,
}: DecideRun): Promise<void> {
  const { job, signal } = ctx;
  return runToolsStep(
    ctx,
    {
      name: STEP,
      async work(tool: Tool, reportAi: (usage: AiUsage) => void) {
        const current = await versions.current(job.reel_id);
        if (!current) throw new Error(`${STEP}: no current version`);
        const parent = await versions.get(current.id);
        if (!parent) throw new Error(`${STEP}: version ${current.id} not found`);
        // An AI version has a prompt version (and a model, when reported).
        if (request === null && (parent.model !== null || parent.prompt_version !== null)) {
          return { what: `version ${parent.number} already decided` };
        }

        const retime = fingerprintOf(fingerprints, "retime", STEP);
        const headTrackFp = fingerprintOf(fingerprints, "head_track", STEP);
        const transcript = await readJson<Transcript>(
          storage,
          cacheKey(keyPrefix, "retime", retime, "transcript.json"),
          STEP,
        );
        const { durationSeconds } = await readJson<{ durationSeconds: number }>(
          storage,
          cacheKey(keyPrefix, "retime", retime, "retime.json"),
          STEP,
        );
        const headTrack = await readJson<HeadTrack>(
          storage,
          cacheKey(keyPrefix, "head_track", headTrackFp, "head-track.json"),
          STEP,
        );
        const preset = ISSEBYA;
        const edit = parseEdit(await readJson<unknown>(storage, parent.r2_key, STEP), {
          transcript,
          preset,
        });
        const context: DecideContext = { transcript, preset, clipDuration: durationSeconds };
        const schema = decideJsonSchema(context);
        const prompt = await decidePrompt({ edit, transcript, headTrack, preset, request });

        const cwd = join(scratchDir, `job-${job.id}`, STEP);
        const measurer = createMeasurer(await fontBytes(preset));
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the job's own scratch folder
          await mkdir(cwd, { recursive: true });
          let model: string | null = null;
          const attempt = async (text: string): Promise<Attempt> => {
            let result;
            try {
              result = await ai.runJson({ prompt: text, schema, tool, cwd });
            } catch (error) {
              if (!(error instanceof AiAnswerError)) throw error;
              if (error.usage) reportAi(error.usage);
              return { ok: false, reasons: [`answer: ${error.message}`] };
            }
            reportAi(result.usage);
            model = result.usage.model;
            return evaluateAttempt({
              output: result.output,
              context,
              inputs: parent.inputs,
              headTrack,
              measurer,
            });
          };

          const first = await attempt(prompt);
          // Exactly one retry, with the reasons; never a loop.
          const passed = first.ok ? first : await attempt(retryPrompt(prompt, first.reasons));
          if (!passed.ok) {
            const firstReasons = first.ok ? [] : first.reasons;
            throw new StepTailError(
              `${STEP} failed twice\n${roundLine(1, firstReasons)}\n${roundLine(2, passed.reasons)}`,
            );
          }

          const { objects, store } = leaseGuarded(storage, versions, signal);
          signal.throwIfAborted();
          await saveVersion({
            objects,
            store,
            prefix: keyPrefix,
            reelId: job.reel_id,
            id: newId(),
            edit: passed.edit,
            meta: {
              request,
              model,
              promptVersion: PROMPT_VERSION,
              changeSummary: passed.answer.change_summary,
              checks: passed.checks,
              freeField: passed.answer.free_field,
              unexpressed: passed.answer.unexpressed,
            },
          });
          const counts = answerCounts(passed.answer);
          const parts = [
            plural(counts.accents, "accent"),
            plural(counts.transitions, "transition"),
            counts.title ? "title set" : "no title",
            plural(counts.fixedWords, "word", " fixed"),
            ...(first.ok ? [] : ["retried once"]),
          ];
          return { what: `decided: ${parts.join(", ")}` };
        } finally {
          measurer.close();
          await rm(cwd, { recursive: true, force: true });
        }
      },
    },
    spawnTool,
  );
}
