# Feature: error tracking with PostHog for the studio, the landing page and the worker

## Metadata

issue_number: `90`
adw_id: `961010ec`
issue_json: `{"number":90,"title":"feat: error tracking with PostHog for the studio, the landing page and the worker"}`

## Feature Description

Production errors today are visible only to someone reading Vercel or worker logs. This feature
sends them to PostHog error tracking (project 312096, the EU host, the same public project token
the apps already read), from all three runtimes:

- the server side of the studio and the landing page: every uncaught request error (route handlers,
  server actions, server components) through Next's `onRequestError`, and every handled failure
  that today only logs with `console.error` and answers an error;
- the studio browser: a handled upload failure in `UploadForm.tsx`, on top of the uncaught errors
  `capture_exceptions: true` already sends;
- the worker: every failed step and every uncaught error of the process.

Each captured exception has a stable message (so PostHog groups it into one issue), an `app`
property (`studio`, `web`, `worker`), the provider's error code or name (R2's `AccessDenied`, a
Supabase error code, a Stripe error code) and, where a user is known, their Supabase id as
`distinct_id`. Nothing is sent without the token (development, CI, E2E, tests), and no property ever
carries a secret, a signed URL, an email address or file contents.

## User Story

As the studio's owner
I want every production failure to show up in PostHog error tracking with its app, place and
provider error code
So that I can see why "Upload failed" happened (for example R2 refusing the studio's key) without
reading runtime logs.

## Problem Statement

On 2026-11-02 the owner pressed Upload six times on `https://edit.issebya.com/studio` and saw only
"Upload failed". The cause (`studio: multipart upload not created: Access Denied`,
`apps/studio/src/lib/upload-server.ts:107`) was only in the studio's runtime log. PostHog project
312096 has no `$exception` events: both browsers send only uncaught browser errors, the server code
of both apps sends nothing (neither app has `posthog-node`), and the worker's failed steps live only
in the database and its own log.

## Solution Statement

Add `posthog-node` to `apps/studio`, `apps/web` and `apps/worker`, each with one small local
error-tracking module (apps never import each other; the repository already copies small helpers
between apps, for example `apps/studio/e2e/events.ts`). Every module follows the analytics pattern:
pure, testable functions that receive the PostHog client as an adapter, a gate that reads the
variables per call (never at module load), and a no-op when the gate is closed.

- **Gate.** Studio server: `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` both
  set (the studio browser's gate). Web server: those two and `NEXT_PUBLIC_VERCEL_ENV ===
"production"` (the landing browser's gate). Worker: `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`
  both set. Browser: unchanged (`startStudioAnalytics` already refuses `navigator.webdriver` and
  empty variables). All are empty in development, CI and E2E, so nothing is sent there.
- **Scrubbing.** One `scrub` function per app redacts URL query strings (signed URLs), known secret
  prefixes (`sb_secret_`, `sb_publishable_`, `sk_`, `rk_`, `whsec_`, `re_`, `phc_`, `phx_`), `Bearer`
  tokens, JWT-shaped strings and email addresses from every string property and from the message
  before capture, and truncates. Handled failures send a stable message of our own (never the
  provider's free text wrapped as `cause`), plus the provider's code or name.
- **Server (studio, web).** `onRequestError` in `instrumentation.ts` (studio: new
  `apps/studio/src/instrumentation.ts`, web: extend `apps/web/src/instrumentation.ts`), Node runtime
  only, imports the module dynamically, builds a short-lived `posthog-node` client
  (`flushAt: 1`, `flushInterval: 0`), captures with `path` (query string removed), `method`,
  `route_path`, `route_type`, `router_kind`, `render_source`, `digest` and `app`, and awaits
  `shutdown()` before returning, so the serverless function flushes before it ends. In the studio
  the `distinct_id` is the Supabase user id read from the request's cookie header with
  `@supabase/ssr` and `auth.getClaims()` (`sub`), anonymous when unknown or on any error.
- **Handled server failures.** One `reportFailure` helper per app logs exactly what `console.error`
  logs today (local logs keep working) and captures one exception with the stable message and a
  small, typed set of properties. Every `console.error` in a studio server action, the upload
  server and the web action, webhook and offer price is replaced by it. `upload-server.ts` takes
  the capture through its `Deps` so its tests use a fake.
- **Browser.** `apps/studio/src/lib/track.ts` gains `captureException(message, properties)`; under
  `navigator.webdriver` with a spec's `window.__capturedEvents` array it records
  `{ event: "$exception", properties }` (the existing test hook), otherwise it calls
  `posthog.captureException` when PostHog is loaded. The uploader observes its own upload-route
  answers (Uppy's Companion client throws only `Companion request failed: <statusText>`, so it can
  not tell the status or the `error` code; see Notes) and `UploadForm.tsx` captures one
  `studio: upload failed` exception per failed upload with `status` and `error_code`.
- **Worker.** `apps/worker/src/error-tracking.ts` builds one tracker per process (created in
  `main.ts` and `once.ts`, passed down like telemetry, flushed before exit). The step runner's
  `withStep` captures every failed step row (`step`, `job_kind`, `reel_id`, `job_id`, `attempt`,
  `retrying`, `failure_kind`, the error tail scrubbed and truncated) with the job's `owner_id` as
  `distinct_id`. `installCrashCapture` adds `uncaughtException` and `unhandledRejection` handlers
  that capture, flush (bounded wait) and exit 1. A missing token builds no client at all.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview; nothing to change.
- `AGENTS.md`: rules (Yarn only, add a dependency to the workspace that uses it, strict turbo env,
  no em-dashes, no real `.env*`, docs rules).
- `.adw/project.md`: the ADW profile; read for commands. No script, port, env file or doc location
  changes, so it needs no edit (confirm at the end; if the implementation adds a variable, add it to
  the Build section).
- `docs/conditional-docs.md`: the docs index; gets one line for the new doc.
- `app_docs/measurement.md`: studio analytics, worker telemetry and the `capture` test hook; gets a
  pointer to the new doc. Its Rules (never initialise PostHog under `navigator.webdriver`, never use
  the email as distinct id, never create telemetry providers at module load) bind this work.
- `app_docs/analytics.md`: the landing page's PostHog gate (production only, `navigator.webdriver`,
  `?notrack`); the web server gate mirrors its production and variable conditions.
- `app_docs/upload.md`: the upload routes, `UploadForm`, the uploader and the storage mock route;
  read its Rules before touching the uploader.
- `app_docs/studio.md`: the studio zone, server client, worker overview.
- `app_docs/failures.md`: step failures, the one automatic retry, `FootageRefused`, `AiUnavailable`;
  the worker capture must not change any of that behaviour.
- `app_docs/checkout.md` and `app_docs/confirmation-email.md`: the web server action and webhook whose
  `console.error` sites get a capture; their Rules on what is logged bind the properties.
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`: the
  `onRequestError(error, request, context)` signature and "await async work" rule (Next 16.3.8).
- `turbo.json`: strict env; check that no new variable is read by a task (see Phase 3).
- `knip.json`: dead-code config; new files under `src/` are already in each workspace's `project`.
- `apps/studio/src/lib/analytics.ts`, `apps/web/src/lib/analytics.ts`: the gates and adapter pattern
  to copy.
- `apps/studio/instrumentation-client.ts`, `apps/web/instrumentation-client.ts`: browser start-up,
  `capture_exceptions: true` stays.
- `apps/studio/src/lib/track.ts`, `apps/studio/src/lib/track.test.ts`: the `capture` test hook;
  `captureException` is added beside it.
- `apps/studio/src/lib/upload-server.ts`, `apps/studio/src/lib/upload-server.test.ts`: the five
  upload failure sites (lines 56, 107, 119, 219, 236) and their DI-based tests.
- `apps/studio/src/lib/upload-routes.ts`: `uploadDeps()` builds `Deps`; it adds the capture.
- `apps/studio/src/app/api/uploads/s3/multipart/route.ts`, `[uploadId]/route.ts`,
  `[uploadId]/complete/route.ts`, `[uploadId]/[partNumber]/route.ts`: the upload routes (they go
  through `upload-server.ts`; any failure that throws reaches `onRequestError`).
- `apps/studio/src/app/actions.ts`, `retry-actions.ts`, `export-actions.ts`, `change-actions.ts`,
  `preview-actions.ts`: server actions with `console.error` failure sites.
- `apps/studio/src/lib/supabase-config.ts`, `apps/studio/src/proxy.ts`: the Supabase config reader
  and the cookie-adapter pattern for `createServerClient` (used to read the user id in
  `onRequestError`).
- `apps/studio/src/lib/uploader.ts`, `apps/studio/src/components/UploadForm.tsx`: the browser upload
  and its failure branch.
- `apps/studio/e2e/multipart-upload.spec.ts`, `apps/studio/e2e/events.ts`: the upload spec and the
  event recorder the new E2E test extends.
- `apps/studio/test-support/worker.ts`: spawns the worker's `once` with OTEL variables blanked;
  `POSTHOG_PROJECT_TOKEN` is blanked the same way.
- `apps/studio/.env.example`, `apps/web/.env.example`, `apps/worker/.env.example`: comments only
  (they already carry the variable names).
- `apps/web/src/instrumentation.ts`: today `register()` only; gets `onRequestError`.
- `apps/web/src/app/actions.ts`, `apps/web/src/app/api/stripe/webhook/route.ts`,
  `apps/web/src/lib/offer-price.ts`: the landing page's `console.error` failure sites.
- `apps/worker/src/step-runner.ts` (`StepContext`, `withStep`), `apps/worker/src/recording-steps.ts`
  (`stepContext` test helper), `apps/worker/src/process-job.ts` (builds `StepContext`),
  `apps/worker/src/main.ts`, `apps/worker/src/once.ts`, `apps/worker/src/loop.ts` (`drain failed`),
  `apps/worker/src/errors.ts` (`errorTail`), `apps/worker/src/failure.ts` (`isTransient`,
  `FootageRefused`), `apps/worker/src/summary.ts` (`outputTail`), `apps/worker/src/telemetry.ts`
  (the per-process, never-at-module-load pattern).

### New Files

- `apps/studio/src/lib/error-tracking.ts`: gate, scrub, `ErrorCapture` adapter type, the
  `posthog-node` client factory, `reportFailure`, `captureRequestError` (pure, client passed in).
- `apps/studio/src/lib/error-tracking.test.ts`: unit tests with a fake client.
- `apps/studio/src/instrumentation.ts`: `onRequestError` (Node runtime only, dynamic import).
- `apps/studio/src/lib/server-failures.test.ts`: the guard test that no `console.error` remains in
  the studio's server code outside `reportFailure`.
- `apps/studio/src/lib/upload-answers.ts` and `upload-answers.test.ts`: the scoped observer of the
  upload routes' error answers (status and `error` code).
- `apps/web/src/lib/error-tracking.ts` and `apps/web/src/lib/error-tracking.test.ts`: the landing
  page's copy (production gate, `app: "web"`, no user id).
- `apps/worker/src/error-tracking.ts` and `apps/worker/src/error-tracking.test.ts`: the worker's
  tracker, scrub, step capture and crash capture.
- `app_docs/error-tracking.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Add `posthog-node` to the three workspaces, read the current PostHog docs for Next.js and Node error
tracking (the `posthog:instrument-error-tracking` skill or posthog.com/docs/error-tracking for
Next.js and Node), and check the installed `posthog-node` API: the constructor options (`host`,
`flushAt`, `flushInterval`), `captureException(error, distinctId?, additionalProperties?)`,
`shutdown(timeoutMs?)`, and whether it serialises `error.cause` (it must not receive the provider's
error as `cause`). Write the three error-tracking modules with their gates and scrub functions,
and their unit tests, before wiring any call site.

### Phase 2: Core Implementation

Wire the request-error hooks in both Next apps, replace every handled server failure's
`console.error` with `reportFailure`, add the browser capture of a failed upload, and add the
worker's step and crash capture.

### Phase 3: Integration

Blank the worker token in the E2E worker helper, extend the multipart upload spec with the forced
create failure, confirm turbo strict env needs no new entry (every new read is
`NEXT_PUBLIC_POSTHOG_*` and `NEXT_PUBLIC_VERCEL_ENV`, inlined at build and already covered by
`NEXT_PUBLIC_*` in `build.env`; the worker reads its `.env` files through `node --env-file`, not
through turbo), update the `.env.example` comments and write the docs.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Add the dependency and read the docs

- `yarn workspace @edit-issebya/studio add posthog-node`
- `yarn workspace @edit-issebya/web add posthog-node`
- `yarn workspace @edit-issebya/worker add posthog-node`
- Read the PostHog Next.js and Node error tracking docs and the installed
  `node_modules/posthog-node` type declarations; record the checked version and the exact
  `captureException` and `shutdown` signatures in comments of the modules below (the repository
  already cites checked versions, for example "posthog-js 1.438.12").
- Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`.

### 2. Studio error-tracking module (`apps/studio/src/lib/error-tracking.ts`)

- `errorTrackingConfig(env = process.env)`: `{ projectToken, host } | null`; null unless both
  `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` are non-empty after trim. Read
  the two variables literally (`process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`) so Next inlines
  them.
- `ERROR_SUPER_PROPERTIES = { app: "studio" }` (reuse `STUDIO_SUPER_PROPERTIES` from
  `analytics.ts`).
- `interface ErrorCapture { capture(error: Error, distinctId: string | undefined, properties: Record<string, string | number | boolean | null>): void; flush(): Promise<void> }`.
- `serverErrorCapture(env?)`: the `posthog-node` adapter, built per call (never at module load):
  `new PostHog(token, { host, flushAt: 1, flushInterval: 0 })`; `capture` calls
  `client.captureException(error, distinctId, properties)`; `flush` awaits `client.shutdown()`
  wrapped in try/catch (a PostHog outage never breaks an answer). Returns `DISABLED_CAPTURE`
  (no-op, no client created) when the gate is closed.
- `scrub(value: string, max = 500)`: replaces `?...` after any `http(s)://` URL with `?[redacted]`,
  secret-prefixed tokens (`sb_secret_`, `sb_publishable_`, `sk_`, `rk_`, `whsec_`, `re_`, `phc_`,
  `phx_` followed by word characters), `Bearer <token>`, JWT-shaped `xxx.yyy.zzz` base64url strings
  and email addresses with `[redacted]`, then truncates to `max` characters.
- `providerCode(error: unknown): string | null`: a Supabase/PostgREST `code`, else an AWS SDK or
  `Error` `name` (R2's `AccessDenied`), else null. `providerMessage(error)`: the error's message
  scrubbed and cut to 200 characters (R2's `Access Denied`), null for non-errors.
- `reportFailure(capture, { message, error?, userId?, properties? })`: writes the same
  `console.error(message + ":", ...)` line the call site wrote before (code and message, never a
  file name), then `capture.capture(new Error(message), userId, { app: "studio", error_code,
error_message, ...properties })` with every string scrubbed, then `await capture.flush()`. The
  `Error` is new, named `StudioFailure`, with no `cause`. `message` is a stable literal, for example
  `studio: multipart upload not created`.
- `captureRequestError(capture, error, request, context, userId)`: `new Error(scrub(message))` keeping
  the original error's `name` and `stack` (scrubbed), properties `app`, `path` (query string
  removed), `method`, `route_path`, `route_type`, `router_kind`, `render_source`, `digest`; then
  flush.
- `requestUserId(cookieHeader, config)`: `createServerClient` (from `@supabase/ssr`) with a
  read-only cookie adapter parsed from the header, `auth.getClaims()`, returns `claims.sub` or
  undefined; any throw gives undefined. Never reads or returns the email.

### 3. Studio unit tests (`apps/studio/src/lib/error-tracking.test.ts`)

- Gate: no client factory call and `DISABLED_CAPTURE` returned when either variable is empty or
  blank; a client when both are set (pass a fake factory, never the real `PostHog`).
- `scrub`: a signed R2 URL (`https://acc.r2.cloudflarestorage.com/b/k?X-Amz-Signature=abc`), an
  `sb_secret_` value, a `Bearer` header, a JWT and an email are each redacted; long input is cut.
  Use low-entropy fake values so `eslint-plugin-no-secrets` stays quiet.
- `reportFailure`: one `capture` call with message `studio: multipart upload not created`, name
  `StudioFailure`, no `cause`, properties `{ app: "studio", error_code: "AccessDenied",
error_message: "Access Denied" }`, the user id as distinct id, then one `flush`. A property
  sweep asserts no value matches `/https?:\/\/\S*\?|sb_secret_|Bearer |@[^ ]+\.[a-z]{2,}/`.
- `captureRequestError`: a request `{ path: "/studio/auth/confirm?token_hash=abc", method: "GET" }`
  and an App Router `route` context give `path: "/studio/auth/confirm"`, `method`, `route_path`,
  `route_type`, `app` and one flush; a throwing `flush` does not reject.
- `requestUserId`: undefined without a cookie header and when the claims call throws (inject the
  client factory).

### 4. Studio request-error hook (`apps/studio/src/instrumentation.ts`)

- `export async function onRequestError(error, request, context)` typed with
  `Instrumentation.onRequestError` from `next`. Return at once unless
  `process.env.NEXT_RUNTIME === "nodejs"`. Dynamically import `@/lib/error-tracking`; return when
  `errorTrackingConfig()` is null (so a run without the token never parses cookies or builds a
  client); read the user id with `requestUserId(request.headers.cookie, supabaseConfig())`, then
  `await captureRequestError(serverErrorCapture(), ...)`. Wrap the whole body in try/catch: the hook
  never throws.
- Keep the file next to `src/app` (the studio uses `src/`; `instrumentation-client.ts` stays where
  it is). Confirm with `next build` output or a dev log that Next picks it up.

### 5. Studio handled server failures

- `upload-server.ts`: add `errors: ErrorCapture` to `Deps` (required). Replace each of the five
  `console.error` calls with `await reportFailure(deps.errors, { message, error, userId })`, with
  stable messages: `studio: upload reel not read`, `studio: multipart upload not created`,
  `studio: reel not created`, `studio: upload not finished`, `studio: upload not failed`. Thread the
  signed-in user's id out of `signedIn` (return `{ supabase, userId }`) so each capture carries it.
  Never pass the file name, key, upload id or signed URL as a property; `reel_id` is allowed.
- `upload-routes.ts`: `uploadDeps()` adds `errors: serverErrorCapture()`.
- `upload-server.test.ts`: a `recordingCapture()` fake (calls and flushes); every existing call passes
  it. New tests: `createUpload` with `createMultipartUpload` rejecting an error named `AccessDenied`,
  message `Access Denied`, answers `{ ok: false, status: 500, error: "failed" }` and captures once
  with `studio: multipart upload not created`, `error_code: "AccessDenied"`, the user id as distinct
  id, and no property value containing the key, `https://` or the file name; the reel insert error,
  the `finish_upload` error and the `fail_upload` error each capture once with their message and the
  Supabase `code`; a successful create, sign, list, complete and abort capture nothing.
- Server actions (`actions.ts`, `retry-actions.ts`, `export-actions.ts`, `change-actions.ts`,
  `preview-actions.ts`): replace every `console.error` with
  `await reportFailure(serverErrorCapture(), { message, error, userId, properties: { reel_id } })`,
  keeping the existing text as the stable message without the trailing colon (for example
  `studio: render job not queued`). `actions.ts` (magic link) never passes the email; send only
  `error_code` (`error.code ?? error.status`). `export-actions.ts:149` (link not signed) sends the
  error name only. Each action already holds the signed-in user where it has one; pass its `id`.
- Client components `ReelPreview.tsx:133` and `PreviewPlayer.tsx:129` are browser code: leave their
  `console.error` (uncaught browser errors already reach PostHog through `capture_exceptions`).
- `apps/studio/src/lib/server-failures.test.ts`: reads every `.ts` file under `src/app/` and
  `src/lib/` (not `*.test.ts`, not `error-tracking.ts`) and fails if one contains `console.error(`,
  so a future handled failure cannot skip the capture. Client components (`src/components/`) are out
  of its scope.

### 6. Studio browser capture of a failed upload

- `apps/studio/src/lib/track.ts`: `captureException(message: string, properties: Record<string, string | number | null>)`.
  Test hook: under `navigator.webdriver` with an array on `window.__capturedEvents`, push
  `{ event: "$exception", properties: { ...STUDIO_SUPER_PROPERTIES, $exception_message: message, ...properties } }`.
  Otherwise, when `posthog.__loaded`, `posthog.captureException(new Error(message), properties)`.
  Widen the hook's event type from `StudioEvent` to `StudioEvent | "$exception"` without touching
  `studio-events.ts` names.
- `apps/studio/src/lib/track.test.ts`: the hook records one `$exception` with `app`, the message and
  the properties; nothing is recorded without `navigator.webdriver` or without the array.
- `apps/studio/src/lib/upload-answers.ts`: `observeUploadAnswers(target: { fetch: typeof fetch }, endpoint: string)`
  wraps `target.fetch` for the duration of one upload: a request whose URL starts with the upload
  endpoint and whose answer is not ok records `{ status, error }` (`error` read from a cloned
  response's JSON `error` string, null when absent or not JSON); every other request passes through
  untouched and its answer is returned unchanged. Returns `{ last(): { status: number; error: string | null } | null; stop(): void }`;
  `stop()` restores the original `fetch` only if the wrapper is still installed.
- `apps/studio/src/lib/upload-answers.test.ts`: a fake `fetch` answering 500 `{ error: "failed" }`
  on `/studio/api/uploads/s3/multipart` is recorded; a 200 and a non-endpoint 500 are not; a
  non-JSON 503 records `error: null`; `stop()` restores the original; the caller still gets a
  readable body.
- `apps/studio/src/lib/uploader.ts`: in `start`, `observeUploadAnswers(window, UPLOAD_ENDPOINT)`
  before `uppy.upload()`, `stop()` in `finally`; the failed outcome becomes
  `{ status: "failed"; answer: { status: number; error: string | null } | null }`.
- `UploadForm.tsx`: on a failed outcome (never on cancel), call once
  `captureException("studio: upload failed", { status: outcome.answer?.status ?? null, error_code: outcome.answer?.error ?? null, resumed: Boolean(resumed) })`.
  No file name, size, key or upload id.

### 7. Landing page error tracking (`apps/web`)

- `apps/web/src/lib/error-tracking.ts`: the studio module's shape with `app: "web"`, no user id
  (anonymous distinct id), and the gate also requiring
  `process.env.NEXT_PUBLIC_VERCEL_ENV === "production"` (read literally). Error name `WebFailure`.
  `providerCode` reads a Stripe error's `code` or `type`, else the error `name` (Resend errors are
  `name`d).
- `apps/web/src/lib/error-tracking.test.ts`: the gate closed on preview, development and empty
  variables (no client factory call); `reportFailure` captures once with `app: "web"` and the Stripe
  code; `captureRequestError` strips the query string (`/?checkout=success&session_id=cs_test_x`
  gives `/`); the secret sweep as in the studio test, including `sk_test_` and `whsec_`.
- `apps/web/src/instrumentation.ts`: add `onRequestError` (Node runtime only, dynamic import of
  `@/lib/error-tracking`, return when the gate is closed, try/catch, awaited flush). Leave
  `register()` and the E2E mocks unchanged.
- `apps/web/src/app/actions.ts`, `apps/web/src/app/api/stripe/webhook/route.ts`,
  `apps/web/src/lib/offer-price.ts`: replace each `console.error` with `reportFailure`, stable
  messages (`startCheckout: no Stripe secret key is configured`, `startCheckout: session without a
url`, `startCheckout: creating the Checkout Session failed`, `stripe webhook: missing
configuration`, `stripe webhook: signature verification failed`, `stripe webhook: sending failed`,
  and the two other webhook sites by their existing text, `currentOfferPrice: counting sold spots
failed`). Properties: the Stripe or Resend code or name, the missing configuration names (variable
  names only, never values); never the buyer's email, name, phone, form text or the session's
  customer details. Keep each existing `console.error` text in the log line.
- Web has no server-failure guard test: its three files are small; list them in the doc instead.

### 8. Worker error tracking (`apps/worker/src/error-tracking.ts`)

- `interface ErrorTracker { stepFailed(input): void; crashed(error: unknown): void; shutdown(timeoutMs?: number): Promise<void>; enabled: boolean }`.
- `createErrorTracker(env = process.env, makeClient = (token, host) => new PostHog(token, { host }))`:
  `DISABLED_TRACKER` (no client built, every method a no-op, `shutdown` resolves) unless both
  `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` are non-empty after trim. Built per process in
  `main.ts` and `once.ts`, never at module load, never global.
- `stepFailed({ job, step, attempt, retrying, error, tail })`: one
  `captureException(new Error("worker: step failed"), job.owner_id, { app: "worker", step, job_kind: job.kind, reel_id: job.reel_id, job_id: job.id, attempt, retrying, failure_kind, error_code, error_tail })`
  where `failure_kind` is `refused` (a `FootageRefused` in the cause chain), `transient`
  (`isTransient`) or `failed`, `error_code` is the innermost error's `code` or `name`, and
  `error_tail` is the tail scrubbed (same rules as the studio's `scrub`) and cut to its last 1000
  characters. Never the job's `request` text (a change request is the owner's words) and never a
  path under the scratch folder beyond what the tail holds after scrubbing.
- `crashed(error)`: `captureException(error scrubbed as in the studio, "worker:" + WORKER_ID or anonymous, { app: "worker", kind: "uncaught" })`.
- `installCrashCapture(tracker, proc = process, exit = process.exit)`: `uncaughtException` and
  `unhandledRejection` handlers that call `tracker.crashed`, `console.error` the error, await
  `tracker.shutdown(3000)` and `exit(1)` (a listener replaces Node's default crash, so it must exit).
- `step-runner.ts`: add `errors: ErrorTracker` to `StepContext`; in `withStep`'s failure branch,
  right after `ctx.steps.failed(...)`, call `ctx.errors.stepFailed(...)` with the same tail written
  to the row and `retrying: retry`. Never on a lost lease (the branch that rethrows on
  `ctx.signal.aborted`) and never on `AiUnavailable` (the row is `waiting`, not failed).
- `recording-steps.ts`: `stepContext(steps, { errors = DISABLED_TRACKER, ... })`.
- `process-job.ts`: take `errors: ErrorTracker` as a parameter and put it on the context.
- `main.ts`, `once.ts`: `const errors = createErrorTracker()` first, then
  `installCrashCapture(errors)`, pass `errors` to `processJob`, and `await errors.shutdown()` beside
  every `telemetry.shutdown()`. `main.ts`'s drainer gets
  `onError: (error) => { console.error("worker: drain failed:", error); errors.crashed(error); }`.
- `apps/worker/src/error-tracking.test.ts`: no token or no host builds no client (factory not
  called) and every method is a safe no-op; with a fake client, `stepFailed` captures once with the
  message and properties above and a tail longer than 1000 characters is cut; a tail holding
  `https://x.r2.cloudflarestorage.com/k?X-Amz-Signature=abc` and `sb_secret_x` is scrubbed;
  `FootageRefused` gives `failure_kind: "refused"`; `installCrashCapture` with a fake `proc`
  (an `EventEmitter`) and a fake `exit` captures one exception on `uncaughtException`, flushes, and
  exits with 1.
- `step-runner.test.ts`: one new test: a step whose tool exits 1 writes the failed row and the
  recording tracker sees one `stepFailed` with `step`, `retrying: false` and the row's tail; a
  transient first failure gives two calls (`retrying: true`, then `false`); an aborted lease gives
  none.

### 9. Keep tests and E2E from sending

- `apps/studio/test-support/worker.ts`: blank `POSTHOG_PROJECT_TOKEN` (beside the two `OTEL_*`
  blanks), so a spawned `once` never sends even when a developer's `.env.development` holds a token.
- `.env.example` comments only: `apps/worker/.env.example` ("PostHog events, logs, traces and
  errors"), `apps/studio/.env.example` and `apps/web/.env.example` note that the same two public
  variables also turn on server error tracking (web: production only). No new names, no values.
- `turbo.json`: confirm no new variable is read by a turbo task; add nothing if so. If the
  implementation ends up reading any other variable on the server, list it under `build.env` (and
  `dev`/`start`/`test:e2e` `passThroughEnv` when read at run time) and in the profile's Build
  section.

### 10. E2E: a forced upload create failure is captured once

- Extend `apps/studio/e2e/multipart-upload.spec.ts` with
  `test("Create fails: the form shows Upload failed and one exception is captured", ...)`, modelled on
  its existing failure tests: `recordEvents(page)`, then `page.route` on `POST` to the create endpoint
  (`**/studio/api/uploads/s3/multipart`, exact path, not the part or complete paths) fulfilling
  `{ status: 500, contentType: "application/json", body: JSON.stringify({ error: "failed" }) }`,
  sign in, `pickAndUpload(page)`.
- Assert the form shows `Upload failed. Pick the file again to start over.` (no resume record was
  written, the create never answered), no reel row was created for the owner, and
  `expect.poll(() => eventsNamed(events, "$exception"))` equals exactly one
  `{ event: "$exception", properties: { app: "studio", $exception_message: "studio: upload failed", status: 500, error_code: "failed", resumed: false } }`.
  Also assert no `studio_footage_uploaded` event.
- This spec fails without the feature: no `$exception` is recorded today. The server-side capture of
  a real storage refusal is proven by the `upload-server.test.ts` unit test (the E2E server runs with
  no token, so a server capture is a no-op there by design).

### 11. Documentation

- `app_docs/error-tracking.md`: Specifications (this plan), Overview, How it works (studio server,
  web server, studio browser, worker; gate per app; the stable messages table with app, place and
  properties), Configuration (the variables, none new; previews of the landing page send nothing;
  the PostHog project must have error tracking enabled), Testing (the unit tests and the E2E test),
  Rules (never send a secret, signed URL, email, file name, file contents or change request text;
  never pass the provider error as `cause`; never build a client at module load or without both
  variables; tests never call PostHog; never capture under `navigator.webdriver`; never use the
  email as distinct id; a new handled server failure goes through `reportFailure`), Notes (source
  maps out of scope, the Uppy status workaround).
- `docs/conditional-docs.md`: one line, "Read `app_docs/error-tracking.md` when changing
  `onRequestError`, `reportFailure` or a handled server failure in the studio or the landing page,
  the studio's `captureException` or the upload failure capture, the worker's error tracker or crash
  handlers, or what an exception may carry."
- `app_docs/measurement.md`: a pointer under Studio analytics and under Telemetry ("Exceptions:
  `app_docs/error-tracking.md`"), and add `$exception` from the upload form to the test hook line.
- No em-dashes anywhere.

### 12. Validation

- Run every command in `Validation Commands`, fix failures at their cause, never weaken a test.

## Testing Strategy

### Unit Tests

- `apps/studio/src/lib/error-tracking.test.ts`: gate, scrub, `reportFailure`, `captureRequestError`,
  `requestUserId`, all with fake clients.
- `apps/studio/src/lib/upload-server.test.ts`: each upload failure captures once with its stable
  message, code and user id and no secret-looking value; successes capture nothing.
- `apps/studio/src/lib/server-failures.test.ts`: no bare `console.error` left in studio server code.
- `apps/studio/src/lib/track.test.ts`: the `$exception` test hook.
- `apps/studio/src/lib/upload-answers.test.ts`: the upload-answer observer.
- `apps/web/src/lib/error-tracking.test.ts`: the production gate, `reportFailure`, the request hook's
  path stripping, the secret sweep.
- `apps/worker/src/error-tracking.test.ts` and one `step-runner.test.ts` test: step capture, retry and
  lease cases, scrubbing and truncation, crash capture, no client without a token.

### Test Coverage

- Unit (studio, `upload-server.test.ts`): an R2 `AccessDenied` on create captures exactly one
  exception with `error_code: "AccessDenied"` and the user id; catches the 2026-11-02 blind spot,
  fails today because nothing is captured.
- Unit (studio and web, `error-tracking.test.ts`): `onRequestError`'s capture carries path without
  query, method, route and `app`, and no property looks like a secret; fails today (no module).
- Unit (studio, `server-failures.test.ts`): a server file still calling `console.error` directly;
  fails today on the twelve existing sites.
- Unit (worker, `error-tracking.test.ts`, `step-runner.test.ts`): a failed step captures one exception
  with step, job kind, reel id and a cut, scrubbed tail; nothing without a token; fails today.
- E2E (studio, `multipart-upload.spec.ts`): a forced create failure shows "Upload failed" and records
  exactly one `$exception` with status 500 and `error_code: "failed"`; fails today (no capture).
- No test for the `.env.example` comments, the doc or the dependency addition: config and
  documentation only.

### Edge Cases

- Token set but host empty (and the reverse): nothing captured, no client built, in every app.
- Web on a Vercel preview with the token set: nothing captured (production only).
- `onRequestError` when PostHog is down or `shutdown` rejects: the hook resolves, the error page
  still renders.
- `onRequestError` in the Edge runtime: returns without importing `posthog-node`.
- A request path with a query (`/studio/auth/confirm?token_hash=...`): the token never leaves.
- A signed-out request, a malformed cookie, a failing `getClaims`: anonymous distinct id, no throw.
- A storage error whose message contains a signed URL: redacted.
- A Supabase error on the magic-link action: the email never appears in any property.
- A cancelled upload: no `$exception`; a failed resume: one, with `resumed: true`.
- A non-JSON error answer (a proxy 502 HTML page): `error_code: null`, status kept.
- A worker step that fails transiently then succeeds: one capture (`retrying: true`); fails twice:
  two.
- A lost lease or an AI usage limit: no capture.
- A `FootageRefused`: captured with `failure_kind: "refused"`.
- An uncaught error in the worker before the first job: captured, flushed (bounded wait), exit 1.
- A step tail over 4096 bytes with multi-byte characters: cut without breaking the string.

## Acceptance Criteria

- `posthog-node` is a dependency of `@edit-issebya/studio`, `@edit-issebya/web` and
  `@edit-issebya/worker` only, added with `yarn workspace ... add`; `yarn.lock` updated.
- Both Next apps export `onRequestError` from `src/instrumentation.ts`; it captures with `app`,
  `path` (no query), `method`, `route_path`, `route_type` and, in the studio, the Supabase user id
  when known, and awaits the flush.
- Every studio server `console.error` (upload server and the five action files) and every web
  server `console.error` (action, webhook, offer price) goes through `reportFailure` with a stable
  message and the provider's code or name; the studio guard test enforces it.
- A failed upload in `UploadForm.tsx` captures exactly one `studio: upload failed` exception with the
  answer's status and error code; a cancel captures none; `capture_exceptions: true` stays in both
  browsers.
- The worker captures every failed step row (step, job kind, reel id, job id, attempt, retrying,
  failure kind, scrubbed tail of at most 1000 characters) and every uncaught error, and flushes
  before exit; without `POSTHOG_PROJECT_TOKEN` or `POSTHOG_HOST` it builds no client.
- Nothing is captured without the variables (development, CI, E2E, tests), under
  `navigator.webdriver`, or, on the landing page, outside production. Tests use fake clients only.
- No property carries a secret, a signed URL, an email address, a file name, file contents or a
  change request's text.
- `app_docs/error-tracking.md` exists, `docs/conditional-docs.md` has its line,
  `app_docs/measurement.md` points to it. No em-dashes. No AI attribution.
- Lint, typecheck, knip, format, unit, build, DB and E2E pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn install --immutable` - the lockfile already holds `posthog-node` for the three workspaces
  (run after the adds; must not change `yarn.lock`).
- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/web --filter=./apps/studio --filter=./apps/worker` - ESLint
  (including `no-secrets` on the test fixtures).
- `yarn turbo run typecheck --filter=./apps/web --filter=./apps/studio --filter=./apps/worker` -
  `next typegen` + `tsc`; `instrumentation.ts`'s `Instrumentation.onRequestError` type, the widened
  `Deps` and `StepContext`.
- `yarn knip` - no unused export or dependency (every new module and `posthog-node` is used).
- `yarn turbo run test --filter=./apps/web --filter=./apps/studio --filter=./apps/worker` - the new
  and existing unit tests (fake clients, no network).
- `yarn workspace @edit-issebya/worker test:tools` - the worker's tool tests (owner's Mac only),
  since `step-runner.ts` and the step context changed.
- `yarn turbo run test:db --filter=./apps/studio` - the DB layer, unchanged schema, regression only.
- `yarn turbo run build --filter=./apps/web --filter=./apps/studio` - both apps build with no
  variables and `instrumentation.ts` compiles for the Node and Edge bundles (the worker's build
  check is its typecheck above).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - the landing and studio suites against
  the `/prepare_app` server, including the new create-failure test and the existing "no PostHog
  request" assertion in `upload.spec.ts`.

## Notes

- New dependency: `posthog-node` (latest 5.x at planning time, 5.61.2), added with
  `yarn workspace @edit-issebya/studio add posthog-node`,
  `yarn workspace @edit-issebya/web add posthog-node` and
  `yarn workspace @edit-issebya/worker add posthog-node`. Read its installed types before relying
  on option names; record the checked version in the modules' comments.
- Why per-app modules and not a `packages/` library: the three modules differ in gate (studio,
  production-only web, worker env), distinct id and capture points, and share only the small
  `scrub` function; a package would also need a new row in the profile's Workspaces table and
  `transpilePackages` in `apps/web`. If the shared part grows, move `scrub` and the adapter types to
  a package then (three consumers satisfy the AGENTS.md rule).
- Why the uploader observes `fetch`: `@uppy/aws-s3` 6.3.0's Companion client
  (`lib/s3-client/CompanionS3.js`, `_fetch`) calls the global `fetch` and on a non-ok answer throws
  `new Error("Companion request failed: " + response.statusText)`, dropping the status and the
  JSON body, and `statusText` is empty over HTTP/2 (Vercel). The observer is installed only during
  one `start()` call, touches only requests to `UPLOAD_ENDPOINT`, reads a cloned body and restores
  the original `fetch` in `finally`. Re-check this when Uppy is upgraded.
- The E2E forced failure uses `page.route` on the create request rather than a server-side storage
  fault: every spec shares one adopted server (`workers: 1`, `reuseExistingServer`), so a
  per-test storage fault would need a new mock toggle route, and the E2E server has no PostHog token,
  so a server capture there is a no-op by design. The server-side R2 refusal is proven by the unit
  test against the same code path.
- Studio previews: the studio's gate has no environment check (same as its browser gate), so a
  preview built with the token also sends server exceptions; filter them in PostHog by
  `$lib`/deployment if needed. The web gate is production only, like its analytics.
- `onRequestError` errors from React server rendering may be the processed error with only a
  `digest`; the `digest` property ties the PostHog issue to the Vercel log line.
- Out of scope (later group, owner step): uploading source maps for readable stack traces, which
  needs a PostHog personal API key in Vercel. Also out of scope: error-tracking alerts in PostHog
  (owner can add them with the PostHog UI once events arrive), and job-level failures outside any
  step (they already reach the step capture when a step failed, and the crash handler otherwise).
- Owner step after merge: confirm error tracking is enabled in PostHog project 312096 settings, set
  `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` in `apps/worker/.env.production` on the worker machine,
  and check the first `$exception` arrives (for example by retrying the failing upload while R2 still
  refuses the key).
