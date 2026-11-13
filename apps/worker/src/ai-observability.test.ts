import { describe, expect, it, vi } from "vitest";
import { type AiRequest, fakeAiRunner, scriptedAnswer } from "./ai.ts";
import {
  type AiGeneration,
  createAiObserver,
  generationEvent,
  jobAiContext,
  withAiContext,
} from "./ai-observability.ts";
import { TEST_JOB } from "./recording-steps.ts";

const ENV = { POSTHOG_PROJECT_TOKEN: "token", POSTHOG_HOST: "https://eu.i.posthog.com" };

// A signed R2 URL, in two parts so no literal looks like a secret.
const R2_OBJECT = "https://x.r2.cloudflarestorage.com/k";
const SIGNED_URL = `${R2_OBJECT}?X-Amz-Signature=abc`;

const SPOKEN = "the owner's spoken words";

const GENERATION: AiGeneration = {
  role: "decide",
  model: "anthropic/claude-haiku-5.5",
  context: {
    traceId: "job-1",
    distinctId: "owner-1",
    reelId: "reel-1",
    photoId: null,
    jobId: "job-1",
    properties: { job_kind: "process" },
  },
  promptVersion: "reel-components@v12",
  promptRef: { name: "reel-components", version: 12, label: "production" },
  promptStale: false,
  outputMode: "json_schema",
  system: "test system prompt",
  user: `## script\n\n${SPOKEN}\n`,
  image: null,
  cacheControl: true,
  maxOutputTokens: 16_000,
  usage: {
    inputTokens: 2400,
    outputTokens: 310,
    costUsd: 0.0042,
    model: "anthropic/claude-haiku-5.5",
    cacheReadTokens: 1800,
    cacheWriteTokens: 0,
  },
  reasoningTokens: 40,
  costSource: "openrouter",
  latencySeconds: 3.25,
  finishReason: "stop",
  answerText: `{"accents":[],"note":"${SPOKEN}"}`,
  outcome: "answer",
  error: null,
  httpStatus: null,
};

let ids = 0;
const options = { privacy: true, fallbackId: "worker:w1", newId: () => `id-${(ids += 1)}` };

describe("the generation event", () => {
  it("is one $ai_generation for the job's owner with the model, tokens, cache counts, cost and latency", () => {
    ids = 0;
    const event = generationEvent(GENERATION, options);
    expect(event.event).toBe("$ai_generation");
    expect(event.distinctId).toBe("owner-1");
    expect(event.properties).toMatchObject({
      $ai_trace_id: "job-1",
      $ai_session_id: null,
      $ai_span_id: "id-1",
      $ai_span_name: "decide",
      $ai_parent_id: "job-1",
      $ai_model: "anthropic/claude-haiku-5.5",
      $ai_provider: "openrouter",
      $ai_input_tokens: 2400,
      $ai_output_tokens: 310,
      $ai_reasoning_tokens: 40,
      $ai_cache_read_input_tokens: 1800,
      $ai_cache_creation_input_tokens: 0,
      // OpenRouter counts the cached tokens inside the input tokens.
      $ai_cache_reporting_exclusive: false,
      $ai_total_cost_usd: 0.0042,
      $ai_cost_passthrough: true,
      $ai_latency: 3.25,
      $ai_stream: false,
      $ai_max_tokens: 16_000,
      $ai_stop_reason: "stop",
      $ai_is_error: false,
      app: "worker",
      ai_role: "decide",
      ai_outcome: "answer",
      ai_output_mode: "json_schema",
      ai_messages: "system_user",
      ai_cache_control: true,
      ai_cost_source: "openrouter",
      prompt_identity: "reel-components@v12",
      prompt_name: "reel-components",
      prompt_version: 12,
      prompt_label: "production",
      prompt_draft_id: null,
      prompt_stale: false,
      reel_id: "reel-1",
      photo_id: null,
      job_id: "job-1",
      job_kind: "process",
    });
    expect(event.properties).not.toHaveProperty("$ai_error");
    expect(event.properties).not.toHaveProperty("$process_person_profile");
  });

  it("carries no message and no answer in privacy mode: no spoken word leaves the worker", () => {
    const event = generationEvent(GENERATION, options);
    expect(event.properties.$ai_input).toBeNull();
    expect(event.properties.$ai_output_choices).toBeNull();
    expect(JSON.stringify(event)).not.toContain(SPOKEN);
    expect(JSON.stringify(event)).not.toContain("test system prompt");
  });

  it("carries the system message, the user message and the answer only with privacy mode off", () => {
    const event = generationEvent(GENERATION, { ...options, privacy: false });
    expect(event.properties.$ai_input).toEqual([
      { role: "system", content: "test system prompt" },
      { role: "user", content: GENERATION.user },
    ]);
    expect(event.properties.$ai_output_choices).toEqual([
      { role: "assistant", content: GENERATION.answerText },
    ]);
  });

  it("names an image, never sends it, and sends one user message on the template path", () => {
    const event = generationEvent(
      {
        ...GENERATION,
        role: "describe",
        system: null,
        user: "",
        image: { mediaType: "image/jpeg", bytes: 4 },
        cacheControl: false,
      },
      { ...options, privacy: false },
    );
    expect(event.properties.$ai_input).toEqual([
      { role: "user", content: [{ type: "text", text: "[image image/jpeg, 4 bytes]" }] },
    ]);
    expect(event.properties).toMatchObject({
      ai_messages: "single",
      ai_has_image: true,
      ai_cache_control: false,
      $ai_span_name: "describe",
    });
  });

  it("names the cost's source, and sends no cost when there is none", () => {
    const listed = generationEvent({ ...GENERATION, costSource: "price_table" }, options);
    expect(listed.properties).toMatchObject({
      ai_cost_source: "price_table",
      $ai_total_cost_usd: 0.0042,
    });
    const none = generationEvent(
      { ...GENERATION, costSource: null, usage: { ...GENERATION.usage, costUsd: null } },
      options,
    );
    expect(none.properties).not.toHaveProperty("$ai_total_cost_usd");
    expect(none.properties).not.toHaveProperty("$ai_cost_passthrough");
    expect(none.properties.ai_cost_source).toBeNull();
  });

  it("leaves the reasoning tokens out when the provider reported none", () => {
    const event = generationEvent({ ...GENERATION, reasoningTokens: null }, options);
    expect(event.properties).not.toHaveProperty("$ai_reasoning_tokens");
  });

  it("marks a broken, an unavailable and a thrown call as errors, the reason scrubbed and cut", () => {
    const failed = generationEvent(
      {
        ...GENERATION,
        outcome: "unavailable",
        error: `the OpenRouter credits are used up ${SIGNED_URL} ${"x".repeat(600)}`,
        httpStatus: 402,
        finishReason: null,
        answerText: null,
      },
      options,
    );
    expect(failed.properties).toMatchObject({
      $ai_is_error: true,
      $ai_http_status: 402,
      ai_outcome: "unavailable",
    });
    const error = String(failed.properties.$ai_error);
    expect(error).toContain(`${R2_OBJECT}?[redacted]`);
    expect(error).not.toContain("X-Amz-Signature");
    expect(error).toHaveLength(500);
    for (const outcome of ["broken", "error"] as const) {
      expect(generationEvent({ ...GENERATION, outcome }, options).properties.$ai_is_error).toBe(
        true,
      );
    }
  });

  it("names a draft by its id, a stale copy as stale, and an eval run as the trace with no person profile", () => {
    const event = generationEvent(
      {
        ...GENERATION,
        role: "judge",
        promptVersion: "draft@v0",
        promptRef: { name: "draft", version: 0, label: "draft", draftId: "draft:ba7816bf8f01" },
        promptStale: true,
        context: {
          traceId: "experiment-1",
          reelId: "reel-2",
          spanName: "judge.owner",
          properties: { source: "eval:judge", eval_case: "case-1" },
        },
      },
      { ...options, base: { service_name: "edit-issebya-worker-dev", worker_id: "w1" } },
    );
    expect(event.distinctId).toBe("worker:w1");
    expect(event.properties).toMatchObject({
      $ai_trace_id: "experiment-1",
      $ai_span_name: "judge.owner",
      $process_person_profile: false,
      prompt_name: "draft",
      prompt_draft_id: "draft:ba7816bf8f01",
      prompt_stale: true,
      reel_id: "reel-2",
      job_id: null,
      source: "eval:judge",
      eval_case: "case-1",
      service_name: "edit-issebya-worker-dev",
      worker_id: "w1",
    });
  });

  it("gives a call with no context its own trace", () => {
    ids = 0;
    const bare: AiGeneration = { ...GENERATION };
    delete bare.context;
    const event = generationEvent(bare, options);
    expect(event.properties).toMatchObject({ $ai_trace_id: "id-1", $ai_parent_id: "id-1" });
    expect(event.distinctId).toBe("worker:w1");
  });
});

function fakeClient() {
  return {
    capture: vi.fn(),
    shutdown: vi.fn<(timeoutMs?: number) => Promise<void>>(async () => undefined),
  };
}

describe("createAiObserver", () => {
  it.each([
    {},
    { POSTHOG_PROJECT_TOKEN: "token" },
    { POSTHOG_HOST: "https://eu.i.posthog.com" },
    { POSTHOG_PROJECT_TOKEN: " ", POSTHOG_HOST: "https://eu.i.posthog.com" },
  ])("builds no client without both variables (%o) and captures nothing", async (env) => {
    const factory = vi.fn();
    const observer = createAiObserver(env, factory);
    expect(observer.enabled).toBe(false);
    observer.generation(GENERATION);
    await observer.shutdown();
    expect(factory).not.toHaveBeenCalled();
  });

  it("captures each generation with the project token and host, in privacy mode by default", () => {
    const client = fakeClient();
    const factory = vi.fn(() => client);
    const observer = createAiObserver(
      { ...ENV, WORKER_ID: "w1", OTEL_SERVICE_NAME: "edit-issebya-worker-dev" },
      factory,
    );
    expect(observer.enabled).toBe(true);
    expect(factory).toHaveBeenCalledWith("token", "https://eu.i.posthog.com");
    observer.generation(GENERATION);
    expect(client.capture).toHaveBeenCalledTimes(1);
    const event = client.capture.mock.calls[0]![0] as ReturnType<typeof generationEvent>;
    expect(event.event).toBe("$ai_generation");
    expect(event.properties).toMatchObject({
      $ai_input: null,
      $ai_output_choices: null,
      service_name: "edit-issebya-worker-dev",
      worker_id: "w1",
    });
  });

  it.each([
    ["false", false],
    ["true", true],
    ["0", true],
    ["", true],
  ])("sends content only when the privacy setting is exactly false (%j)", (value, privacy) => {
    const client = fakeClient();
    createAiObserver({ ...ENV, POSTHOG_PRIVACY_MODE: value }, () => client).generation(GENERATION);
    const event = client.capture.mock.calls[0]![0] as ReturnType<typeof generationEvent>;
    expect(event.properties.$ai_input === null).toBe(privacy);
  });

  it("never throws when PostHog does, on a capture or at shutdown", async () => {
    const client = {
      capture: vi.fn(() => {
        throw new Error("posthog down");
      }),
      shutdown: vi.fn(async () => {
        throw new Error("posthog down");
      }),
    };
    const observer = createAiObserver(ENV, () => client);
    expect(() => observer.generation(GENERATION)).not.toThrow();
    await expect(observer.shutdown(1000)).resolves.toBeUndefined();
    expect(client.shutdown).toHaveBeenCalledWith(1000);
  });
});

describe("withAiContext", () => {
  const REQUEST: AiRequest = {
    role: "decide",
    prompt: "x",
    promptVersion: "test-prompt@v1",
    schema: { type: "object" },
  };

  it("sets the context on every call, a call's own fields winning", async () => {
    const inner = fakeAiRunner([scriptedAnswer({})]);
    const ai = withAiContext(inner, { traceId: "t1", reelId: "r1", properties: { a: 1, b: 2 } });
    await ai.call(REQUEST);
    await ai.call({ ...REQUEST, observe: { traceId: "t2", properties: { b: 3 } } });
    expect(inner.calls.map((call) => call.observe)).toEqual([
      { traceId: "t1", reelId: "r1", properties: { a: 1, b: 2 } },
      { traceId: "t2", reelId: "r1", properties: { a: 1, b: 3 } },
    ]);
    // The double's record stays reachable through the wrapper.
    expect(ai.calls).toBe(inner.calls);
  });

  it("makes a job the trace and its owner the person", () => {
    expect(jobAiContext(TEST_JOB)).toEqual({
      traceId: TEST_JOB.id,
      distinctId: TEST_JOB.owner_id,
      reelId: TEST_JOB.reel_id,
      photoId: TEST_JOB.photo_id,
      jobId: TEST_JOB.id,
      properties: { job_kind: TEST_JOB.kind },
    });
  });
});
