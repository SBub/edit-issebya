import { PostHog } from "posthog-node";

// The landing page's server error tracking (see app_docs/error-tracking.md), a
// copy of the studio's module (apps never import each other) with the landing
// page's gate: production only, like its browser analytics. No user is known
// here, so every exception is anonymous. Pure
// functions over an ErrorCapture adapter, so tests pass a fake and never call
// PostHog. The gate is read per call, never at module load, and a closed gate
// builds no client at all.
//
// Checked against posthog-node 5.61.1 (dist/client.d.ts):
// `new PostHog(token, { host, flushAt, flushInterval })`,
// `captureException(error: unknown, distinctId?: string, additionalProperties?)`
// (queues a pending promise) and `shutdown(shutdownTimeoutMs?): Promise<void>`
// (awaits it and sends). The captured Error is always built here with no
// `cause`, so no provider's free text rides along unscrubbed.

/** A property value an exception may carry: never an object. */
export type ErrorPropertyValue = string | number | boolean | null;
export type ErrorProperties = Record<string, ErrorPropertyValue>;

export interface ErrorCapture {
  capture(error: Error, distinctId: string | undefined, properties: ErrorProperties): void;
  /** Sends what was captured. Never rejects: a PostHog outage never breaks an answer. */
  flush(): Promise<void>;
}

/** The gate closed: nothing is captured, no client exists. */
export const DISABLED_CAPTURE: ErrorCapture = {
  capture() {},
  async flush() {},
};

// Sent with every exception, so the landing page's never mix with the studio's.
const WEB_PROPERTIES = { app: "web" } as const;

interface ErrorTrackingEnv {
  vercelEnv: string | undefined;
  projectToken: string | undefined;
  host: string | undefined;
}

/**
 * The landing browser's three public variables, by their literal names so
 * Next inlines them. Null (closed) unless both PostHog variables are set and
 * this is the production deployment: previews, development, CI and E2E send
 * nothing.
 */
export function errorTrackingConfig(
  env: ErrorTrackingEnv = {
    vercelEnv: process.env.NEXT_PUBLIC_VERCEL_ENV,
    projectToken: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  },
): { projectToken: string; host: string } | null {
  const projectToken = env.projectToken?.trim();
  const host = env.host?.trim();
  if (env.vercelEnv !== "production" || !projectToken || !host) return null;
  return { projectToken, host };
}

type PostHogClient = Pick<PostHog, "captureException" | "shutdown">;

const makePostHog = (projectToken: string, host: string): PostHogClient =>
  // flushAt 1 and flushInterval 0: a serverless function may end right after
  // the answer, so nothing waits in a batch.
  new PostHog(projectToken, { host, flushAt: 1, flushInterval: 0 });

/**
 * The posthog-node adapter, built per request (never at module load). The
 * client is created on the first capture and shut down by `flush`, so a
 * request that fails nowhere builds none.
 */
export function serverErrorCapture(
  config: { projectToken: string; host: string } | null = errorTrackingConfig(),
  makeClient: (projectToken: string, host: string) => PostHogClient = makePostHog,
): ErrorCapture {
  if (!config) return DISABLED_CAPTURE;
  let client: PostHogClient | null = null;
  return {
    capture(error, distinctId, properties) {
      client ??= makeClient(config.projectToken, config.host);
      client.captureException(error, distinctId, properties);
    },
    async flush() {
      const pending = client;
      client = null;
      if (!pending) return;
      try {
        await pending.shutdown();
      } catch {
        // PostHog down: the failure is still in the log line.
      }
    },
  };
}

const REDACTED = "[redacted]";

// Each pattern has a single quantifier level (security/detect-unsafe-regex).
const SCRUBBERS: [RegExp, string][] = [
  // A URL's query string: a signed URL's signature and credential live there.
  [/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, `$1?${REDACTED}`],
  // Secret-prefixed tokens: Supabase, Stripe, Resend, PostHog.
  [/\b(?:sb_secret_|sb_publishable_|sk_|rk_|whsec_|re_|phc_|phx_)\w+/g, REDACTED],
  [/\bBearer\s+[^\s"',]+/gi, `Bearer ${REDACTED}`],
  // A JWT: its header always starts with eyJ ({").
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED],
];

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * Redacts what must never reach PostHog (query strings, secret-prefixed
 * tokens, Bearer tokens, JWTs, email addresses), then truncates.
 */
export function scrub(value: string, max = 500): string {
  let out = value;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return cut(out, max);
}

function field(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/**
 * The provider's error code: a Stripe error's `code` or `type`, else the
 * error's `name` (Resend's errors are named), else null.
 */
function providerCode(error: unknown): string | null {
  for (const key of ["code", "type"]) {
    const value = field(error, key);
    if (typeof value === "string" && value !== "") return scrub(value, 100);
  }
  const name = field(error, "name");
  if (typeof name === "string" && name !== "" && name !== "Error") return scrub(name, 100);
  return null;
}

/** The provider's message, scrubbed and cut to 200 characters; null for a non-error. */
function providerMessage(error: unknown): string | null {
  const message = field(error, "message");
  return typeof message === "string" && message !== "" ? scrub(message, 200) : null;
}

function scrubProperties(properties: ErrorProperties): ErrorProperties {
  const out: ErrorProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = typeof value === "string" ? scrub(value) : value;
  }
  return out;
}

export interface Failure {
  /** A stable literal, so PostHog groups every occurrence into one issue. */
  message: string;
  /** The provider's error: only its code or name and its scrubbed message are sent. */
  error?: unknown;
  properties?: ErrorProperties;
  /** What the log line prints after the message; the code and message by default. */
  log?: unknown[];
}

/**
 * A handled server failure: logs the line the call site always logged, then
 * captures one exception with the stable message and flushes. Never throws.
 */
export async function reportFailure(capture: ErrorCapture, failure: Failure): Promise<void> {
  const code = failure.error === undefined ? null : providerCode(failure.error);
  const message = failure.error === undefined ? null : providerMessage(failure.error);
  const details = failure.log ?? [code, message];
  if (details.length === 0) console.error(failure.message);
  else console.error(`${failure.message}:`, ...details);
  try {
    const error = new Error(failure.message);
    error.name = "WebFailure";
    capture.capture(
      error,
      undefined,
      scrubProperties({
        ...WEB_PROPERTIES,
        error_code: code,
        error_message: message,
        ...failure.properties,
      }),
    );
  } catch {
    // Never let the capture break the answer.
  }
  await capture.flush();
}

/** What onRequestError receives (Next 16 instrumentation.md), the parts used here. */
export interface RequestErrorRequest {
  path: string;
  method: string;
}

export interface RequestErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
}

/** A path without its query string or fragment (a magic link's token_hash rides there). */
function pathOnly(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? "";
}

/** The thrown error, rebuilt with its message and stack scrubbed and no cause. */
function scrubbedError(thrown: unknown, fallbackName: string): Error {
  const original = thrown instanceof Error ? thrown : null;
  const error = new Error(scrub(original ? original.message : String(thrown)));
  error.name = original?.name ? scrub(original.name, 100) : fallbackName;
  error.stack = original?.stack ? scrub(original.stack, 4000) : undefined;
  return error;
}

/**
 * An uncaught request error (route handler, server action, server
 * component): captured with where it happened, then flushed. Never throws.
 */
export async function captureRequestError(
  capture: ErrorCapture,
  thrown: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
): Promise<void> {
  try {
    const digest = field(thrown, "digest");
    capture.capture(
      scrubbedError(thrown, "Error"),
      undefined,
      scrubProperties({
        ...WEB_PROPERTIES,
        path: pathOnly(request.path),
        method: request.method,
        route_path: context.routePath,
        route_type: context.routeType,
        router_kind: context.routerKind,
        render_source: context.renderSource ?? null,
        digest: typeof digest === "string" ? digest : null,
      }),
    );
  } catch {
    // Never let the capture break the error page.
  }
  await capture.flush();
}
