import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { AiRequest, AiRole, AiRunner, OutputMode } from "./ai.ts";
import type { PromptRef } from "./prompts/source.ts";
import type { ClaimedJob } from "./queue.ts";
import { scrub } from "./scrub.ts";
import type { AiUsage } from "./step-store.ts";

// THE WORKER'S AI GENERATIONS (app_docs/measurement.md, "AI generations"):
// every model call the AI runner makes is one PostHog `$ai_generation` event,
// captured by hand with posthog-node (the manual capture of PostHog's AI
// observability). The observer is built per process (main.ts, once.ts, the
// evals, the doctor) and passed to the runner, never at module load, never
// global. Without both POSTHOG_PROJECT_TOKEN and POSTHOG_HOST no client is
// built and nothing is captured. An event carries numbers and names only: the
// messages and the answer go with it only when POSTHOG_PRIVACY_MODE is exactly
// "false", and the image bytes never.

type Env = Record<string, string | undefined>;

// What a call belongs to: the trace (the job, or the eval run), who it is for
// and what it is about. Set on the request by `withAiContext`.
export interface AiCallContext {
  // The job id, or the eval's experiment id.
  traceId: string;
  // The reel's owner; absent for a call no owner asked for (an eval, the doctor).
  distinctId?: string;
  // The span's name; the call's role when absent.
  spanName?: string;
  reelId?: string | null;
  photoId?: string | null;
  jobId?: string;
  // More properties of the event (the eval's case, the job's kind): names and
  // ids only, never text.
  properties?: Record<string, string | number | boolean | null>;
}

// One model call as the runner saw it: what it sent, what came back, how long
// it took.
export interface AiGeneration {
  role: AiRole;
  // The model asked for; `usage.model` is the one that answered.
  model: string;
  context?: AiCallContext;
  promptVersion: string;
  promptRef?: PromptRef;
  promptStale: boolean;
  outputMode: OutputMode;
  // The system message; null on the template path (one user message).
  system: string | null;
  user: string;
  image: { mediaType: string; bytes: number } | null;
  // Whether the system message was marked cacheable.
  cacheControl: boolean;
  maxOutputTokens: number;
  usage: AiUsage;
  reasoningTokens: number | null;
  // Where `usage.costUsd` comes from: OpenRouter's response, or the price table.
  costSource: "openrouter" | "price_table" | null;
  latencySeconds: number;
  finishReason: string | null;
  answerText: string | null;
  // `error` is a call that threw (a refused schema, a bug, a cancel).
  outcome: "answer" | "broken" | "unavailable" | "error";
  error: string | null;
  httpStatus: number | null;
}

export interface AiObserver {
  // True only when a client was built.
  enabled: boolean;
  generation(generation: AiGeneration): void;
  // Sends what was captured; never rejects. Call before the process exits.
  shutdown(timeoutMs?: number): Promise<void>;
}

/** The gate closed: nothing is captured. */
export const DISABLED_AI_OBSERVER: AiObserver = {
  enabled: false,
  generation() {},
  async shutdown() {},
};

const PROVIDER = "openrouter";
const ERROR_CHARS = 500;

export interface GenerationEvent {
  distinctId: string;
  event: "$ai_generation";
  properties: Record<string, unknown>;
}

// The event of one generation. `privacy` leaves the messages and the answer
// out (null, as PostHog's own integrations send them in privacy mode).
// `fallbackId` is the distinct id of a call no owner asked for; such an event
// builds no person profile.
export function generationEvent(
  generation: AiGeneration,
  options: {
    privacy: boolean;
    fallbackId: string;
    // What every event of this process carries (its service name, its worker id).
    base?: Record<string, string | null>;
    newId?: () => string;
  },
): GenerationEvent {
  const { context, usage, promptRef } = generation;
  const newId = options.newId ?? randomUUID;
  const traceId = context?.traceId ?? newId();
  const failed = generation.outcome !== "answer";
  const user: unknown = generation.image
    ? [
        ...(generation.user === "" ? [] : [{ type: "text", text: generation.user }]),
        // The image is named, never sent.
        {
          type: "text",
          text: `[image ${generation.image.mediaType}, ${generation.image.bytes} bytes]`,
        },
      ]
    : generation.user;
  return {
    distinctId: context?.distinctId ?? options.fallbackId,
    event: "$ai_generation",
    properties: {
      $ai_trace_id: traceId,
      // One trace is the whole workload: no session.
      $ai_session_id: null,
      $ai_span_id: newId(),
      $ai_span_name: context?.spanName ?? generation.role,
      $ai_parent_id: traceId,
      $ai_model: usage.model ?? generation.model,
      $ai_provider: PROVIDER,
      $ai_input_tokens: usage.inputTokens,
      $ai_output_tokens: usage.outputTokens,
      ...(generation.reasoningTokens !== null
        ? { $ai_reasoning_tokens: generation.reasoningTokens }
        : {}),
      $ai_cache_read_input_tokens: usage.cacheReadTokens,
      $ai_cache_creation_input_tokens: usage.cacheWriteTokens,
      // OpenRouter's input tokens already include the cached ones.
      $ai_cache_reporting_exclusive: false,
      // The worker's own cost (OpenRouter's, else the price table): PostHog
      // keeps it instead of pricing the call again.
      ...(usage.costUsd !== null
        ? { $ai_total_cost_usd: usage.costUsd, $ai_cost_passthrough: true }
        : {}),
      $ai_latency: generation.latencySeconds,
      $ai_stream: false,
      $ai_max_tokens: generation.maxOutputTokens,
      $ai_stop_reason: generation.finishReason,
      $ai_is_error: failed,
      ...(generation.error !== null
        ? { $ai_error: scrub(generation.error).slice(0, ERROR_CHARS) }
        : {}),
      ...(generation.httpStatus !== null ? { $ai_http_status: generation.httpStatus } : {}),
      $ai_input: options.privacy
        ? null
        : [
            ...(generation.system !== null ? [{ role: "system", content: generation.system }] : []),
            { role: "user", content: user },
          ],
      $ai_output_choices:
        options.privacy || generation.answerText === null
          ? null
          : [{ role: "assistant", content: generation.answerText }],
      ...(context?.distinctId ? {} : { $process_person_profile: false }),
      app: "worker",
      ...options.base,
      ai_role: generation.role,
      ai_outcome: generation.outcome,
      ai_requested_model: generation.model,
      ai_output_mode: generation.outputMode,
      ai_messages: generation.system !== null ? "system_user" : "single",
      ai_cache_control: generation.cacheControl,
      ai_cost_source: generation.costSource,
      ai_has_image: generation.image !== null,
      prompt_identity: generation.promptVersion,
      prompt_name: promptRef?.name ?? null,
      prompt_version: promptRef?.version ?? null,
      prompt_label: promptRef?.label ?? null,
      prompt_draft_id: promptRef?.draftId ?? null,
      prompt_stale: generation.promptStale,
      reel_id: context?.reelId ?? null,
      photo_id: context?.photoId ?? null,
      job_id: context?.jobId ?? null,
      ...context?.properties,
    },
  };
}

type PostHogClient = Pick<PostHog, "capture" | "shutdown">;

export function createAiObserver(
  env: Env = process.env,
  makeClient: (projectToken: string, host: string) => PostHogClient = (projectToken, host) =>
    new PostHog(projectToken, { host }),
): AiObserver {
  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim();
  const host = env.POSTHOG_HOST?.trim();
  if (!projectToken || !host) return DISABLED_AI_OBSERVER;
  const client = makeClient(projectToken, host);
  // Content leaves the worker only when the owner turned privacy mode off.
  const privacy = env.POSTHOG_PRIVACY_MODE?.trim() !== "false";
  const workerId = env.WORKER_ID?.trim();
  const fallbackId = workerId ? `worker:${workerId}` : "worker";
  // The service name tells a development worker from the production one, as on
  // its OpenTelemetry spans (telemetry.ts).
  const base = {
    service_name: env.OTEL_SERVICE_NAME?.trim() || "edit-issebya-worker",
    worker_id: workerId ?? null,
  };
  return {
    enabled: true,
    generation(generation) {
      // A capture never breaks an AI call.
      try {
        client.capture(generationEvent(generation, { privacy, fallbackId, base }));
      } catch {
        // PostHog refused it: the call's usage is still in the step row.
      }
    },
    async shutdown(timeoutMs) {
      try {
        await client.shutdown(timeoutMs);
      } catch {
        // PostHog down: nothing more to do before exit.
      }
    },
  };
}

// The runner with every call's context set (a call's own context wins, field
// by field): what ties its generation event to a job or an eval run.
export function withAiContext<Runner extends AiRunner>(
  runner: Runner,
  context: AiCallContext,
): Runner {
  return {
    ...runner,
    call: (request: AiRequest) =>
      runner.call({
        ...request,
        observe: {
          ...context,
          ...request.observe,
          properties: { ...context.properties, ...request.observe?.properties },
        },
      }),
  };
}

// A job's context: the job is the trace, its owner the person.
export function jobAiContext(job: ClaimedJob): AiCallContext {
  return {
    traceId: job.id,
    distinctId: job.owner_id,
    reelId: job.reel_id,
    photoId: job.photo_id,
    jobId: job.id,
    properties: { job_kind: job.kind },
  };
}
