import { readFileSync } from "node:fs";
import { type Attributes, type Context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  type LanguageModel,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  Output,
  RetryError,
  generateText,
  jsonSchema,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AiUsage } from "./step-store.ts";
import type { Telemetry } from "./telemetry.ts";

type Env = Record<string, string | undefined>;

// The one model every AI call uses, as OpenRouter names it. Change it here (or
// per role in AI_MODELS); every version and photo row records the model that
// answered.
export const AI_MODEL = "anthropic/claude-haiku-5.5";

// What a call is for: the written hook, the decide answer, an editorial round,
// the version title and summary, a library photo's description.
export type AiRole = "hook" | "decide" | "editorial" | "summary" | "describe";

export const AI_MODELS: Readonly<Record<AiRole, string>> = {
  hook: AI_MODEL,
  decide: AI_MODEL,
  editorial: AI_MODEL,
  summary: AI_MODEL,
  describe: AI_MODEL,
};

// US dollars per million tokens, for a call whose cost OpenRouter did not
// report (OpenRouter's list price for Haiku 5.5, prompts up to 100k tokens).
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  [AI_MODEL]: { input: 0.1, output: 0.5 },
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// One call's budget, its retries included; past it the AI is not answering.
const TIMEOUT_MS = 180_000;
// One more try on a network error, a 429 or a 5xx (the AI SDK's backoff).
const MAX_RETRIES = 1;
// Room for the longest decide answer; an answer cut off here is broken.
const MAX_OUTPUT_TOKENS = 16_000;

// One structured call: the prompt (the one user message, no system prompt),
// its identity (`<name>@v<version>`, from PostHog) and the temperature the
// prompt carries, the JSON Schema the answer must match, and for describe_photo
// the image.
export interface AiRequest {
  role: AiRole;
  prompt: string;
  promptVersion: string;
  temperature: number;
  // Set when the prompt is a stale copy (PostHog did not answer): the span and the record say so.
  promptStale?: true;
  schema: Record<string, unknown>;
  image?: { data: Uint8Array; mediaType: "image/jpeg" };
  // The job's signal: a lost lease or a cancel stops the call.
  signal?: AbortSignal;
  // The span this call's `chat` span is a child of, and the telemetry it is
  // recorded with. Without it the call is not traced.
  trace?: { telemetry: Telemetry; parent: Context };
}

// How the answer was asked for: the JSON Schema as a strict structured
// output, or plain JSON mode with the schema in the prompt (the fallback when
// the provider refuses the schema).
export type OutputMode = "json_schema" | "json";

// What one call sent and what came back, as stored with a decide version
// (app_docs/decide-step.md): never a key, never the image bytes.
export interface AiExchange {
  role: AiRole;
  model: string;
  prompt: string;
  promptVersion: string;
  temperature: number;
  // Set only when the prompt was a stale copy.
  promptStale?: true;
  schema: Record<string, unknown>;
  image: { mediaType: string; bytes: number } | null;
  outputMode: OutputMode;
  // The model's raw text; null when nothing came back.
  answerText: string | null;
  finishReason: string | null;
  usage: AiUsage;
  // Why the call gave no answer (broken or unavailable); null for an answer.
  error: string | null;
}

export type AiResult =
  | { kind: "answer"; answer: unknown; usage: AiUsage; exchange: AiExchange }
  | { kind: "broken"; reason: string; usage: AiUsage; exchange: AiExchange }
  // The AI cannot answer now (no key, no credits, a rate limit, OpenRouter
  // down): the job waits.
  | { kind: "unavailable"; reason: string; usage: AiUsage; exchange: AiExchange };

export interface AiRunner {
  call(request: AiRequest): Promise<AiResult>;
}

export const NO_USAGE: AiUsage = {
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  model: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The cost of a call from the price table, when the model has a price.
export function listPriceUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const price = PRICES[model];
  if (!price || (inputTokens === null && outputTokens === null)) return null;
  return ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / 1_000_000;
}

interface SdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
}

// One call's usage: every input token (cache reads and writes included), the
// output tokens, the cost OpenRouter reported (else the list price), and the
// model that answered.
function usageOf(sdk: SdkUsage | undefined, model: string, providerMetadata: unknown): AiUsage {
  const inputTokens = count(sdk?.inputTokens);
  const outputTokens = count(sdk?.outputTokens);
  const reported = count(
    (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter
      ?.usage?.cost,
  );
  return {
    inputTokens,
    outputTokens,
    costUsd: reported ?? listPriceUsd(model, inputTokens, outputTokens),
    model,
    cacheReadTokens: count(sdk?.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: count(sdk?.inputTokenDetails?.cacheWriteTokens),
  };
}

// The constraints Anthropic's strict structured outputs refuse (string
// lengths, number bounds, array lengths beyond minItems 0 or 1) and the
// `$schema` line, left out of the schema sent. The answer is still checked
// against all of them by Zod.
const UNSENT = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
]);

export function wireSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(wireSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSENT.has(key)) continue;
    if (key === "minItems" && typeof value === "number" && value > 1) continue;
    // `properties` maps names to schemas: a property may be called `maxLength`.
    out[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, wireSchema(sub)]))
        : wireSchema(value);
  }
  return out;
}

// The JSON mode prompt: the prompt, then the schema the answer must match.
function jsonModePrompt(prompt: string, schema: Record<string, unknown>): string {
  return [
    prompt.trimEnd(),
    "",
    "Answer with one JSON object only, matching this JSON Schema:",
    "```json",
    JSON.stringify(wireSchema(schema)),
    "```",
    "Reply with the JSON object only, no code fence around it.",
    "",
  ].join("\n");
}

// The JSON in a JSON mode answer: a leading and trailing Markdown code fence
// (```json or ``` with any language) stripped, then, when text is still left
// around it, the outermost object (the first `{` to the last `}`). Nothing
// else is guessed: text with no object comes back as it is, to fail parsing.
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[\w-]*[ \t]*\n?([\s\S]*?)\n?[ \t]*```$/.exec(trimmed);
  const inner = (fenced ? fenced[1]! : trimmed).trim();
  if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  const first = inner.indexOf("{");
  const last = inner.lastIndexOf("}");
  return first !== -1 && last > first ? inner.slice(first, last + 1) : inner;
}

const NOT_JSON = Symbol("not JSON");

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

// The HTTP status of a failed call, through the AI SDK's retry wrapper.
function statusOf(error: unknown): number | null {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(last) ? (last.statusCode ?? null) : null;
}

const NETWORK =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i;

// Why the AI cannot answer now, from a failed call; null when the failure is
// not of that kind (a bad request, a bug).
export function aiUnavailableReason(error: unknown): string | null {
  if (LoadAPIKeyError.isInstance(error)) return "the OpenRouter key is not set";
  const status = statusOf(error);
  if (status === 401 || status === 403) return "the OpenRouter key is refused";
  if (status === 402) return "the OpenRouter credits are used up";
  if (status === 429) return "the rate limit is reached";
  if (status === 408 || (status !== null && status >= 500)) return "OpenRouter is not answering";
  if (status !== null) return null;
  const last = RetryError.isInstance(error) ? error.lastError : error;
  const name = last instanceof Error ? last.name : "";
  const message = last instanceof Error ? `${last.message} ${String(last.cause ?? "")}` : "";
  if (name === "TimeoutError" || name === "AbortError" || NETWORK.test(message)) {
    return "OpenRouter is not answering";
  }
  return null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The `chat` span of one model call, a child of `request.trace`'s span, with
// the OpenTelemetry GenAI semantic conventions (status Development:
// https://github.com/open-telemetry/semantic-conventions-genai). Its name is
// `chat <model>`. Spans are observation only: the call runs, and fails, as it
// would without one. A call that does not succeed carries `error.type`
// (`unavailable` or `broken`; a thrown call is `broken`) and an error status.
async function inChatSpan(
  request: AiRequest,
  model: string,
  work: () => Promise<AiResult>,
): Promise<AiResult> {
  if (!request.trace) return work();
  const { telemetry, parent } = request.trace;
  const span = telemetry.tracer.startSpan(
    `chat ${model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openrouter",
        "gen_ai.request.model": model,
        "gen_ai.request.temperature": request.temperature,
        "edit_issebya.ai.role": request.role,
        "edit_issebya.ai.prompt_version": request.promptVersion,
        ...(request.promptStale ? { "edit_issebya.ai.prompt_stale": true } : {}),
      },
    },
    parent,
  );
  try {
    const result = await work();
    span.setAttributes(chatAttributes(result.exchange));
    if (result.kind !== "answer") {
      span.setAttribute("error.type", result.kind);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setAttribute("error.type", "broken");
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

// The facts of one call on its `chat` span: the response model, the input
// tokens (every input token), the output tokens, the cache counts when
// non-zero, the cost (a custom attribute: the standard has none), the finish
// reason and how the answer was asked for. A value not known is left out.
function chatAttributes(exchange: AiExchange): Attributes {
  const { usage } = exchange;
  const attributes: Attributes = { "edit_issebya.ai.output_mode": exchange.outputMode };
  if (usage.model !== null) attributes["gen_ai.response.model"] = usage.model;
  if (usage.inputTokens !== null) attributes["gen_ai.usage.input_tokens"] = usage.inputTokens;
  if (usage.outputTokens !== null) attributes["gen_ai.usage.output_tokens"] = usage.outputTokens;
  if (usage.cacheReadTokens !== null && usage.cacheReadTokens > 0) {
    attributes["gen_ai.usage.cache_read.input_tokens"] = usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== null && usage.cacheWriteTokens > 0) {
    attributes["gen_ai.usage.cache_write.input_tokens"] = usage.cacheWriteTokens;
  }
  if (usage.costUsd !== null) attributes["edit_issebya.ai.cost_usd"] = usage.costUsd;
  if (exchange.finishReason !== null) {
    attributes["gen_ai.response.finish_reasons"] = [exchange.finishReason];
  }
  return attributes;
}

export interface ModelRunnerOptions {
  // The language model for a role's model id.
  model: (id: string) => LanguageModel;
  maxRetries?: number;
  timeoutMs?: number;
  // Every request, in order (the double's record).
  onCall?: (request: AiRequest) => void;
}

// One call through the AI SDK: the prompt as the one user message (with the
// image for describe_photo), the schema as a strict structured output, the
// answer parsed as JSON (never validated here: the caller's Zod check gives
// the reasons the retry sends back). A schema the provider refuses (HTTP 400)
// is asked again once in JSON mode. A key, credit, rate or network failure is
// `unavailable`; a cancel is rethrown; anything else is thrown.
export function modelRunner(options: ModelRunnerOptions): AiRunner {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    call(request) {
      options.onCall?.(request);
      const modelId = AI_MODELS[request.role];
      return inChatSpan(request, modelId, async () => {
        const exchangeOf = (
          outputMode: OutputMode,
          fields: Partial<AiExchange> & { usage: AiUsage },
        ): AiExchange => ({
          role: request.role,
          model: modelId,
          prompt:
            outputMode === "json" ? jsonModePrompt(request.prompt, request.schema) : request.prompt,
          promptVersion: request.promptVersion,
          temperature: request.temperature,
          ...(request.promptStale ? { promptStale: true as const } : {}),
          schema: request.schema,
          image: request.image
            ? { mediaType: request.image.mediaType, bytes: request.image.data.byteLength }
            : null,
          outputMode,
          answerText: null,
          finishReason: null,
          error: null,
          ...fields,
        });
        const once = async (outputMode: OutputMode): Promise<AiResult> => {
          // A call after a lost lease never starts.
          request.signal?.throwIfAborted();
          const prompt =
            outputMode === "json" ? jsonModePrompt(request.prompt, request.schema) : request.prompt;
          const output =
            outputMode === "json_schema"
              ? Output.object({
                  schema: jsonSchema(
                    wireSchema(request.schema) as Parameters<typeof jsonSchema>[0],
                  ),
                  name: request.role,
                })
              : Output.json();
          try {
            const result = await generateText({
              // Inside the try: a missing key is an unavailable AI.
              model: options.model(modelId),
              ...(request.image
                ? {
                    messages: [
                      {
                        role: "user" as const,
                        content: [
                          { type: "text" as const, text: prompt },
                          {
                            type: "file" as const,
                            data: request.image.data,
                            mediaType: request.image.mediaType,
                          },
                        ],
                      },
                    ],
                  }
                : { prompt }),
              output,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              temperature: request.temperature,
              maxRetries,
              timeout: timeoutMs,
              ...(request.signal ? { abortSignal: request.signal } : {}),
            });
            const usage = usageOf(
              result.usage,
              result.response.modelId || modelId,
              result.providerMetadata,
            );
            const exchange = exchangeOf(outputMode, {
              usage,
              answerText: result.text,
              finishReason: result.finishReason,
            });
            if (result.finishReason === "length") {
              const reason = "the answer was cut off at the output limit";
              return { kind: "broken", reason, usage, exchange: { ...exchange, error: reason } };
            }
            return { kind: "answer", answer: result.output, usage, exchange };
          } catch (error) {
            if (request.signal?.aborted) throw error;
            if (NoObjectGeneratedError.isInstance(error)) {
              const usage = usageOf(error.usage, error.response?.modelId || modelId, undefined);
              const answerText = error.text ?? null;
              const finishReason = error.finishReason ?? null;
              // JSON mode: a fenced or wrapped answer still parses once its
              // JSON is extracted; the exchange keeps the raw text.
              const extracted =
                outputMode === "json" && answerText !== null && finishReason !== "length"
                  ? parsedJson(extractJson(answerText))
                  : NOT_JSON;
              if (extracted !== NOT_JSON) {
                return {
                  kind: "answer",
                  answer: extracted,
                  usage,
                  exchange: exchangeOf(outputMode, { usage, answerText, finishReason }),
                };
              }
              const reason = `the answer is not JSON (${reasonOf(error.cause ?? error).split("\n")[0]})`;
              return {
                kind: "broken",
                reason,
                usage,
                exchange: exchangeOf(outputMode, {
                  usage,
                  answerText,
                  finishReason,
                  error: reason,
                }),
              };
            }
            const unavailable = aiUnavailableReason(error);
            if (unavailable) {
              const usage = { ...NO_USAGE, model: modelId };
              return {
                kind: "unavailable",
                reason: unavailable,
                usage,
                exchange: exchangeOf(outputMode, { usage, error: unavailable }),
              };
            }
            throw error;
          }
        };
        try {
          return await once("json_schema");
        } catch (error) {
          if (statusOf(error) !== 400) throw error;
          return once("json");
        }
      });
    },
  };
}

// The real runner: OpenRouter with the worker's key, usage accounting on (the
// response carries the cost), only providers that take every parameter sent
// (the structured output included). Without a key every call is unavailable.
export function openRouterRunner(apiKey: string | undefined): AiRunner {
  const key = apiKey?.trim();
  const openrouter = key ? createOpenRouter({ apiKey: key, baseURL: OPENROUTER_BASE_URL }) : null;
  return modelRunner({
    model(id) {
      if (!openrouter) {
        throw new LoadAPIKeyError({ message: "OPENROUTER_API_KEY is not set" });
      }
      return openrouter(id, { usage: { include: true }, provider: { require_parameters: true } });
    },
  });
}

// One scripted reply of the AI double: an answer (with the usage and model it
// reports), raw text (not JSON: a broken answer), or an HTTP error (a 402 is
// unavailable, a 400 a refused schema). A reply naming `"role": "hook"` answers
// only the hook calls; a reply naming no role answers every other call.
export type ScriptedReply =
  | string
  | ((
      | {
          answer: unknown;
          usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
          model?: string;
        }
      | { error: { status: number; message?: string } }
    ) & { role?: "hook" });

// A scripted answer, for the double and the tests.
export function scriptedAnswer(answer: unknown): ScriptedReply {
  return { answer };
}

export interface FakeAiRunner extends AiRunner {
  // Every request, in order.
  calls: AiRequest[];
}

const FAKE_URL = `${OPENROUTER_BASE_URL}/chat/completions`;

// The replies that answer a role's calls: the hook calls take those naming
// `hook`, every other call those naming no role; each lane is in order.
function laneOf(script: readonly ScriptedReply[], hook: boolean): ScriptedReply[] {
  return script.filter((reply) => {
    const named = typeof reply === "object" && reply.role === "hook";
    return named === hook;
  });
}

// The AI double: the real runner over a scripted model. Each model call takes
// the next reply of its lane (the hook lane or the rest), then the lane's last
// again. It never touches the network and never retries.
export function fakeAiRunner(script: readonly ScriptedReply[]): FakeAiRunner {
  const calls: AiRequest[] = [];
  const lanes = { hook: laneOf(script, true), other: laneOf(script, false) };
  const replies = { hook: 0, other: 0 };
  // The role of the call being made: `onCall` runs before the model does.
  let role: AiRole = "decide";
  const model = (id: string) =>
    new MockLanguageModelV4({
      provider: "openrouter",
      modelId: id,
      async doGenerate() {
        const lane = role === "hook" ? "hook" : "other";
        const replyList = lanes[lane];
        if (replyList.length === 0) {
          throw new Error(
            lane === "hook"
              ? "fake AI runner has no scripted hook answer"
              : "fake AI runner has no scripted answer",
          );
        }
        const reply = replyList[Math.min(replies[lane], replyList.length - 1)]!;
        replies[lane] += 1;
        if (typeof reply === "object" && "error" in reply) {
          const { status, message } = reply.error;
          throw new APICallError({
            message: message ?? `HTTP ${status}`,
            url: FAKE_URL,
            requestBodyValues: {},
            statusCode: status,
            isRetryable: status === 429 || status >= 500,
          });
        }
        const text = typeof reply === "string" ? reply : JSON.stringify(reply.answer);
        const usage = typeof reply === "string" ? {} : (reply.usage ?? {});
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: usage.input_tokens ?? 0,
              noCache: usage.input_tokens ?? 0,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: usage.output_tokens ?? 0,
              text: undefined,
              reasoning: undefined,
            },
          },
          ...(usage.cost_usd !== undefined
            ? { providerMetadata: { openrouter: { usage: { cost: usage.cost_usd } } } }
            : {}),
          response: {
            modelId: typeof reply === "string" ? id : (reply.model ?? id),
          },
          warnings: [],
        };
      },
    });
  return {
    calls,
    ...modelRunner({
      model,
      maxRetries: 0,
      onCall: (request) => {
        calls.push(request);
        role = request.role;
      },
    }),
  };
}

function scriptFrom(path: string): ScriptedReply[] {
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own script file
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`E2E_MOCK_AI_SCRIPT ${path} cannot be read: ${(error as Error).message}`);
  }
  let script: unknown;
  try {
    script = JSON.parse(text);
  } catch (error) {
    throw new Error(`E2E_MOCK_AI_SCRIPT ${path} is not JSON: ${(error as Error).message}`);
  }
  const refusal = `E2E_MOCK_AI_SCRIPT ${path} must be a non-empty JSON array or one reply object`;
  if (Array.isArray(script)) {
    if (script.length === 0) throw new Error(refusal);
    return script as ScriptedReply[];
  }
  if (script !== null && typeof script === "object") return [script as ScriptedReply];
  throw new Error(refusal);
}

// A decide answer with no items: what the double gives without a script.
export const EMPTY_DECIDE_ANSWER = {
  accents: [],
  big_words: [],
  visuals: [],
  transitions: [],
  word_fixes: [],
};

// The hook the double gives without a script: a plain line, nothing spoken.
const DEFAULT_HOOK_ANSWER = { text: "A short test hook" };

// The double only when E2E_MOCK_AI is exactly "true" (its script from
// E2E_MOCK_AI_SCRIPT, a JSON array of replies replayed in order with the last
// repeating, or one reply object used for every call; without a script the
// empty decide answer and the default hook); otherwise OpenRouter with
// OPENROUTER_API_KEY.
export function aiRunner(env: Env = process.env): AiRunner {
  if (env.E2E_MOCK_AI === "true") {
    const path = env.E2E_MOCK_AI_SCRIPT?.trim();
    return fakeAiRunner(
      path
        ? scriptFrom(path)
        : [{ answer: DEFAULT_HOOK_ANSWER, role: "hook" }, scriptedAnswer(EMPTY_DECIDE_ANSWER)],
    );
  }
  return openRouterRunner(env.OPENROUTER_API_KEY);
}
