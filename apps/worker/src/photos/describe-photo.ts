import { readFile } from "node:fs/promises";
import type { Context } from "@opentelemetry/api";
import type { Storage } from "@edit-issebya/storage";
import { type AiRunner, NO_USAGE } from "../ai.ts";
import { AiUnavailable, PermanentError, permanentAfterAiCall } from "../failure.ts";
import {
  PROMPT_NAMES,
  type PromptSource,
  type PromptText,
  promptIdentity,
} from "../prompts/source.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, StepError, runToolsStep } from "../step-runner.ts";
import { type AiUsage, addUsage } from "../step-store.ts";
import { type DescribeAnswer, describeJsonSchema, parseDescribeAnswer } from "./describe-schema.ts";
import { describePrompt } from "./describe-prompt.ts";
import { largeCopyPath, runPhotoImages } from "./photo-images.ts";
import type { PhotoStore } from "./photo-store.ts";

export const STEP = "describe_photo";

type Attempt = { ok: true; answer: DescribeAnswer } | { ok: false; reasons: string[] };

export interface DescribeStepRun {
  ctx: StepContext;
  ai: AiRunner;
  // The fetched `photo-describe` prompt.
  template: PromptText;
  // The large JPEG copy `photo_images` made in this scratch.
  largePath: string;
  // Tests pass a fake; otherwise the real child process.
  spawnTool?: SpawnTool;
}

function roundLines(round: number, reasons: readonly string[]): string[] {
  return [`round ${round}:`, ...reasons.map((reason) => `- ${reason}`)];
}

// The `describe_photo` step: the large copy sent with the prompt as one
// JPEG image (no file access, no tools), its answer checked by Zod. A refused
// (or broken) answer goes back once with its reasons; a second refusal fails the step with both rounds' reasons and the
// usage spent. An unavailable AI makes the job wait. From the first call on,
// every other failure is permanent (never a third call).
async function describeStep({
  ctx,
  ai,
  template,
  largePath,
  spawnTool,
}: DescribeStepRun): Promise<{ answer: DescribeAnswer; usage: AiUsage }> {
  let result: { answer: DescribeAnswer; usage: AiUsage } | null = null;
  await runToolsStep(
    ctx,
    {
      name: STEP,
      async work(_tool, stepContext: Context) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
        const image = { data: await readFile(largePath), mediaType: "image/jpeg" as const };
        let usage: AiUsage = NO_USAGE;
        const attempt = async (previous?: string[]): Promise<Attempt> => {
          const answer = await ai.call({
            role: "describe",
            ...describePrompt(template, previous),
            schema: describeJsonSchema,
            image,
            signal: ctx.signal,
            trace: { telemetry: ctx.telemetry, parent: stepContext },
          });
          usage = addUsage(usage, answer.usage);
          if (answer.kind === "unavailable") throw new AiUnavailable(answer.reason);
          if (answer.kind === "broken") {
            return { ok: false, reasons: [`the answer was not valid JSON: ${answer.reason}`] };
          }
          return parseDescribeAnswer(answer.answer);
        };

        // Exactly one retry, never a loop.
        const first = await attempt().catch(permanentAfterAiCall);
        const passed = first.ok ? first : await attempt(first.reasons).catch(permanentAfterAiCall);
        if (!passed.ok) {
          const tail = [
            `${STEP}: the answer failed twice`,
            ...roundLines(1, first.ok ? [] : first.reasons),
            ...roundLines(2, passed.reasons),
          ].join("\n");
          throw new StepError(tail, tail, usage);
        }
        result = { answer: passed.answer, usage };
        const { tags } = passed.answer;
        return { what: `${tags.length} tags: ${tags.join(", ")}`, ai: usage };
      },
    },
    spawnTool,
  );
  if (!result) throw new Error(`${STEP}: no result`);
  return result;
}

export interface DescribePhotoJob {
  ctx: StepContext;
  // The job's recording storage (records against the photo).
  storage: Storage;
  store: PhotoStore;
  ai: AiRunner;
  // The one prompt source of the worker process (its `photo-describe` is fetched here).
  prompts: PromptSource;
  tools: Pick<ToolPaths, "ffmpeg" | "ffprobe">;
  keyPrefix: string;
  scratchDir: string;
  photoId: string;
  spawnTool?: SpawnTool;
}

// A `describe_photo` job: the photo's row, the `photo_images` step, the
// `describe_photo` step, then the row written `ready`. A photo deleted before
// the job starts fails it for good; one deleted meanwhile fails the ready
// write (never retried: the AI was already called).
export async function runDescribePhotoJob({
  ctx,
  storage,
  store,
  ai,
  prompts,
  tools,
  keyPrefix,
  scratchDir,
  photoId,
  spawnTool,
}: DescribePhotoJob): Promise<void> {
  const photo = await store.read(photoId);
  if (!photo) throw new PermanentError("photo is gone");
  // Before any work or AI call: a failed fetch costs nothing but this job's try.
  const template = await prompts.get(PROMPT_NAMES.describe);
  const images = await runPhotoImages({
    ctx,
    storage,
    tools,
    keyPrefix,
    scratchDir,
    photoId,
    originalKey: photo.r2_key,
    spawnTool,
  });
  const { answer, usage } = await describeStep({
    ctx,
    ai,
    template,
    largePath: largeCopyPath(scratchDir),
    spawnTool,
  });
  ctx.signal.throwIfAborted();
  await store
    .ready(photoId, {
      description: answer.description,
      tags: answer.tags,
      model: usage.model,
      promptVersion: promptIdentity(template),
      width: images.width,
      height: images.height,
      thumbnailKey: images.thumbnailKey,
      largeKey: images.largeKey,
    })
    .catch(permanentAfterAiCall);
}
