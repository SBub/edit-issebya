import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type DecideAnswer,
  type Edit,
  type EditRef,
  ISSEBYA_PRESET,
  type Measurer,
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
import { AiUnavailableError } from "../failures.ts";
import { editMeasurer } from "../edit-measurer.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { type StepContext, StepError, type Tool, runToolsStep } from "../step-runner.ts";
import type { AiUsage } from "../step-store.ts";
import { decideInput } from "./input.ts";
import { PROMPT_VERSION, decidePrompt } from "./prompt.ts";

const STEP = "decide";
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
}

type Attempt =
  { ok: true; edit: Edit; answer: DecideAnswer; reasons: [] } | { ok: false; reasons: string[] };

function addUsage(total: AiUsage, usage: AiUsage): AiUsage {
  const sum = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  return {
    inputTokens: sum(total.inputTokens, usage.inputTokens),
    outputTokens: sum(total.outputTokens, usage.outputTokens),
    costUsd: sum(total.costUsd, usage.costUsd),
    model: usage.model ?? total.model,
  };
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
// so the current version stays. A passing answer becomes a new version.
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
}: DecideRun): Promise<void> {
  const preset = ISSEBYA_PRESET;
  return runToolsStep(ctx, {
    name: STEP,
    async work(tool: Tool) {
      const reelId = ctx.job.reel_id;
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
      const schema = decideJsonSchema(preset, transcript, current.duration);
      const input = decideInput({ current, transcript, headTrack, preset, request });
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
          // No second call and nothing written: the job waits for the AI.
          if (result.kind === "unavailable") throw new AiUnavailableError(result.reason, usage);
          if (result.kind === "broken") {
            return { ok: false, reasons: [`the answer was not valid JSON: ${result.reason}`] };
          }
          const answer = parseDecideAnswer(result.answer, preset, transcript, current.duration);
          if (!answer.ok) return answer;
          const composed = editFromAnswer(current, answer.answer, preset, transcript);
          if (!composed.ok) return composed;
          const checks = [
            ...build(composed.edit, transcript, headTrack, preset, measure).checks,
            ...glossaryChecks(composed.edit, transcript, preset),
          ];
          if (checks.length > 0) {
            return {
              ok: false,
              reasons: checks.map((check) => `${check.rule} ${check.item}: ${check.reason}`),
            };
          }
          return { ok: true, edit: composed.edit, answer: answer.answer, reasons: [] };
        };

        // Exactly one retry, never a loop.
        const first = await attempt();
        const passed = first.ok ? first : await attempt(first.reasons);
        if (!passed.ok) {
          const tail = [
            `${STEP}: the answer failed twice, version ${row.number} stays current`,
            ...roundLines(1, first.reasons),
            ...roundLines(2, passed.reasons),
          ].join("\n");
          throw new StepError(tail, tail, usage);
        }

        ctx.signal.throwIfAborted();
        const { edit, answer } = passed;
        const saved = await saveVersion(
          { rows, blobs, keyPrefix, newId },
          {
            reelId,
            parentId: currentId,
            restoredFromId: null,
            request,
            model: usage.model,
            promptVersion: PROMPT_VERSION,
            changeSummary: answer.change_summary,
            // The passing build's checks: none failed.
            checks: [],
            usedFreeField: usedFreeField(edit) || answer.free_field.length > 0,
            unexpressed: answer.unexpressed,
            freeField: answer.free_field,
            rejectedReasons: first.ok ? [] : first.reasons,
            edit,
          },
        );
        const counts = decideCounts(edit, transcript, preset);
        const what = [
          `version ${saved.number}: ${plural(counts.accents, "accent")}`,
          plural(counts.transitions, "transition"),
          counts.title ? "title set" : "no title",
          `${plural(counts.wordsFixed, "word")} fixed`,
        ].join(", ");
        return { what, ai: usage };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  });
}
