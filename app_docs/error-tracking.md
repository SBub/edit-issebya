# Error tracking (PostHog)

**Specifications:**

- specs/issue-90-adw-961010ec-sdlc_planner-posthog-error-tracking.md

## Overview

Production failures of the studio (server and browser), the landing page (server) and the worker go
to PostHog error tracking in project 312096 as `$exception` events. Each carries a stable message (so
every occurrence groups into one PostHog issue), the property `app` (`studio`, `web` or `worker`),
the provider's error code or name and, where a user is known, the Supabase user id as `distinct_id`.
Nothing is sent, and no client is built, without the PostHog variables.

## How it works

### Gate per app

- Studio server and browser: `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` both
  set (`errorTrackingConfig` in `apps/studio/src/lib/error-tracking.ts`).
- Landing page server: the same two variables and `NEXT_PUBLIC_VERCEL_ENV === "production"`
  (`errorTrackingConfig` in `apps/web/src/lib/error-tracking.ts`), like its browser analytics.
- Worker: `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` both set (`createErrorTracker` in
  `apps/worker/src/error-tracking.ts`).
- The gate is read per call, never at module load. A closed gate returns `DISABLED_CAPTURE` (server)
  or `DISABLED_TRACKER` (worker) and builds no client.

### Studio and landing page server

- `onRequestError` in each app's `src/instrumentation.ts` captures every uncaught request error
  (route handlers, server actions, server components). Node runtime only (`NEXT_RUNTIME` is
  `nodejs`), the tracking module imported dynamically so the Edge bundle never pulls in
  `posthog-node`, wrapped in try/catch so it never breaks the error page, and it awaits the flush so
  a serverless function sends before it ends.
- `captureRequestError` rebuilds the thrown error with its message, name and stack scrubbed and no
  `cause`, and sends `app`, `path` (without its query string or fragment), `method`, `route_path`,
  `route_type`, `router_kind`, `render_source` and `digest`.
- `serverErrorCapture` is a short-lived `posthog-node` client (`flushAt: 1`, `flushInterval: 0`),
  created on the first capture and shut down by `flush()`, so a request that fails nowhere builds
  none. A PostHog outage never breaks an answer: `flush()` never rejects.
- The studio's `requestUserId` reads the request's cookie header through `@supabase/ssr`
  (`createServerClient`, read-only cookies) and `auth.getClaims()`, and returns the JWT's `sub`;
  undefined when signed out, not configured or on any error. Never the email. The landing page knows
  no user, so its exceptions are anonymous.
- `reportFailure(capture, failure)` is how a handled server failure is reported: it logs the same
  `console.error` line the call site always printed, captures a new `Error` named `StudioFailure`
  (studio) or `WebFailure` (web) with the stable message and no `cause`, adds `error_code` (the
  provider's `code`, else its `name`; the landing page also reads Stripe's `type`) and
  `error_message` (the provider's message, scrubbed and cut to 200 characters), scrubs every string
  property, then flushes. It never throws.
- `apps/studio/src/lib/upload-server.ts` takes its capture through `Deps.errors`, so its tests pass a
  fake; the server actions call `serverErrorCapture()` directly.
- `scrub` redacts a URL's query string (a signed URL's signature lives there), secret-prefixed tokens
  (`sb_secret_`, `sb_publishable_`, `sk_`, `rk_`, `whsec_`, `re_`, `phc_`, `phx_`), `Bearer` tokens,
  JWT-shaped strings (`eyJ...`) and email addresses, then truncates (500 characters by default,
  without splitting a surrogate pair).

### Studio browser

- `captureException(message, properties)` in `apps/studio/src/lib/track.ts` calls
  `posthog.captureException(new Error(message), properties)` when PostHog is loaded. Under
  `navigator.webdriver` PostHog never initialises, and the test hook records
  `{ event: "$exception", properties }` instead (with `app` and `$exception_message`).
- `observeUploadAnswers` in `apps/studio/src/lib/upload-answers.ts` wraps `fetch` for the duration
  of one `start()` in `apps/studio/src/lib/uploader.ts` and remembers the last error answer of the
  upload routes: its status and its JSON `error` code. Every other request passes through untouched,
  and `stop()` restores the original `fetch`. Why: see Notes.
- `apps/studio/src/components/UploadForm.tsx` captures one `studio: upload failed` per failed upload,
  never on cancel, with the routes' answer only.
- `reportBrowserFailure(message, properties)` in `apps/studio/src/lib/track.ts` captures a handled
  browser failure through `captureException` when PostHog is loaded; without PostHog it records it
  for the test hook and prints it with `console.warn` only. `LiveReel` reports
  `studio: realtime channel dropped` once per status change when the reel's Realtime channel turns
  `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED` (never for the close an unmount causes).
- Uncaught browser errors still come from PostHog's own `capture_exceptions: true`.

### Worker

- `createErrorTracker()` is built first thing in `apps/worker/src/main.ts` and
  `apps/worker/src/once.ts`, passed through `processJob` onto `StepContext.errors` (like telemetry),
  never global.
- `withStep` in `apps/worker/src/step-runner.ts` calls `stepFailed` after the failed step row is
  written, so every failed row (including the first attempt of a retried step) is one exception.
  Never on a lost lease (the signal aborted) or on `AiUnavailable` (the step waits, it has not
  failed). The `distinct_id` is the job's `owner_id`.
- `runJob` in `apps/worker/src/run-job.ts` calls `jobFailed` for a failure outside any step (one
  that is not a step's own failure), just before the job row is written `failed`.
- `stepFailed` adds `failed_rules` and `rounds` from the error's `AnswerRefused` cause (rule names
  only), else null; such a failure's `failure_kind` is `answer_refused`.
- A photo job's exception carries `photo_id` (beside a null `reel_id`) in place of a reel id.
- A job stopped because its reel or photo was deleted (`JobGone`, outcome `deleted`) is not
  captured, neither as `worker: step failed` nor as `worker: job failed` (`app_docs/studio.md`).
- `installCrashCapture` listens to `uncaughtException` and `unhandledRejection`: it logs, captures
  (`crashed`, `kind: "uncaught"`, `distinct_id` `worker:<WORKER_ID>` when set), waits for a bounded
  `shutdown(3000)` and exits 1. The drainer's `onError` in `main.ts` also calls `crashed`.
- `errors.shutdown()` runs beside every `telemetry.shutdown()` before the process exits.
- The reel page's overlay actions (`studio_failure_action`, `app_docs/status.md`) carry the failed
  job's `job_id`, which links an action to the job's `worker: step failed` or `worker: job failed`.

### Failure log records (development and production)

- Every failed step attempt, and every job failure outside a step, is exactly one ERROR log record
  (`emitFailureLog` in `apps/worker/src/telemetry.ts`, called from `withStep` in `step-runner.ts` at
  the same point as `stepFailed`, and from `runJob` in `run-job.ts` beside `jobFailed`). It goes
  through the OpenTelemetry logger and its OTLP exporter, the same in development (local Grafana) and
  production (PostHog). A retried first attempt is a record too, with `failure.retrying` true.
- Attributes: `job.id`, `job.kind`, `reel.id` or `photo.id`, `step.name` and `step.attempt` (a job
  failure has `job.attempt` instead), `failure.kind`, `failure.message` (the first line of the
  reason, scrubbed, at most 500 characters), `failure.reasons` (the failed row's tail, scrubbed) and
  `failure.retrying`. The record's trace and span ids are the failing step's or the job's span.
- The failing step span carries a `failure` event with `failure.kind`, `failure.message` and
  `failure.reasons`, so the trace view shows the reasons.
- Captured tool output lines are INFO records with the `stream` attribute: nothing is an ERROR
  because it went to stderr.
- With the PostHog gate closed, `createErrorTracker` returns `DISABLED_TRACKER`: nothing is captured
  or sent to PostHog, but the failure records above are still exported.
- A job stopped because its reel or photo was deleted writes no failure record: it is not a failure.
- A crash (`crashed`) is captured to PostHog only; it has no log record, and in development it shows
  only in the worker's console.
- How to read them in local Grafana: `app_docs/measurement.md`, "Failures in Grafana".

### Stable messages

| Message                                                           | App         | Place                                         | Properties                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio: upload reel not read`                                    | studio      | `src/lib/upload-server.ts`                    | `error_code`, `error_message`                                                                                                                                                                                                                                                                             |
| `studio: multipart upload not created`                            | studio      | `src/lib/upload-server.ts`                    | `error_code`, `error_message`                                                                                                                                                                                                                                                                             |
| `studio: reel not created`                                        | studio      | `src/lib/upload-server.ts`                    | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: upload not finished`                                     | studio      | `src/lib/upload-server.ts`                    | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: upload not failed`                                       | studio      | `src/lib/upload-server.ts`                    | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: magic link not sent`                                     | studio      | `src/app/actions.ts`                          | `error_code` only, never the email, no `distinct_id`                                                                                                                                                                                                                                                      |
| `studio: reel not read for a change`                              | studio      | `src/app/change-actions.ts`                   | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: change job not queued`, `studio: restore job not queued` | studio      | `src/app/change-actions.ts`                   | `error_code`, `error_message`, `reel_id`, never the request text                                                                                                                                                                                                                                          |
| `studio: job not read for a retry`                                | studio      | `src/app/retry-actions.ts`                    | `error_code`, `error_message`, `reel_id`, `job_id`                                                                                                                                                                                                                                                        |
| `studio: retry not queued`                                        | studio      | `src/app/retry-actions.ts`                    | `error_code`, `error_message`, `reel_id`, `job_id`                                                                                                                                                                                                                                                        |
| `studio: reel not read for an export`                             | studio      | `src/app/export-actions.ts`                   | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: render job not queued`                                   | studio      | `src/app/export-actions.ts`                   | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: export not read`                                         | studio      | `src/app/export-actions.ts`                   | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: export key refused`                                      | studio      | `src/app/export-actions.ts`                   | `reel_id`                                                                                                                                                                                                                                                                                                 |
| `studio: export link not signed`                                  | studio      | `src/app/export-actions.ts`                   | `reel_id`, `error_code` (the error's name only)                                                                                                                                                                                                                                                           |
| `studio: preview not signed`                                      | studio      | `src/app/preview-actions.ts`                  | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: reel not deleted`                                        | studio      | `src/lib/reel-server.ts`                      | `error_code`, `error_message`, `reel_id`                                                                                                                                                                                                                                                                  |
| `studio: upload failed`                                           | studio      | `src/components/UploadForm.tsx` (browser)     | `status`, `error_code`, `resumed`                                                                                                                                                                                                                                                                         |
| `studio: realtime channel dropped`                                | studio      | `src/components/LiveReel.tsx` (browser)       | `reel_id`, `status` (`CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED`); console only without PostHog                                                                                                                                                                                                              |
| `startCheckout: no Stripe secret key is configured`               | web         | `src/app/actions.ts`                          | none                                                                                                                                                                                                                                                                                                      |
| `startCheckout: session without a url`                            | web         | `src/app/actions.ts`                          | none                                                                                                                                                                                                                                                                                                      |
| `startCheckout: creating the Checkout Session failed`             | web         | `src/app/actions.ts`                          | `error_code`, `error_message`                                                                                                                                                                                                                                                                             |
| `stripe webhook: no webhook secret`                               | web         | `src/app/api/stripe/webhook/route.ts`         | `missing_config` (variable names only, never values)                                                                                                                                                                                                                                                      |
| `stripe webhook: missing config`                                  | web         | `src/app/api/stripe/webhook/route.ts`         | `missing_config` (variable names only, never values)                                                                                                                                                                                                                                                      |
| `stripe webhook: signature verification failed`                   | web         | `src/app/api/stripe/webhook/route.ts`         | none                                                                                                                                                                                                                                                                                                      |
| `stripe webhook: sending failed`                                  | web         | `src/app/api/stripe/webhook/route.ts`         | `error_code`, `error_message`                                                                                                                                                                                                                                                                             |
| `stripe webhook: emails sent but the sent flag was not written`   | web         | `src/app/api/stripe/webhook/route.ts`         | `error_code`, `error_message`                                                                                                                                                                                                                                                                             |
| `currentOfferPrice: counting sold spots failed`                   | web         | `src/lib/offer-price.ts`                      | `error_code`, `error_message`                                                                                                                                                                                                                                                                             |
| `worker: step failed`                                             | worker      | `src/step-runner.ts`                          | `step`, `job_kind`, `reel_id`, `photo_id`, `job_id`, `attempt`, `retrying`, `failure_kind` (`refused`, `answer_refused`, `transient` or `failed`), `failed_rules` and `rounds` (from the `AnswerRefused` cause, else null), `error_code` (innermost cause), `error_tail` (scrubbed, last 1000 characters) |
| `worker: job failed`                                              | worker      | `src/run-job.ts` (a failure outside any step) | `job_kind`, `reel_id`, `photo_id`, `job_id`, `failure_kind`, `error_code`, `error_tail` (scrubbed, last 1000 characters); `distinct_id` the owner                                                                                                                                                         |
| the crash's own scrubbed message                                  | worker      | `src/error-tracking.ts` (crash capture)       | `kind: "uncaught"`                                                                                                                                                                                                                                                                                        |
| the request error's own scrubbed message                          | studio, web | `src/instrumentation.ts`                      | `path`, `method`, `route_path`, `route_type`, `router_kind`, `render_source`, `digest`                                                                                                                                                                                                                    |

Every row also carries `app`. A `reportFailure` row without a provider error still sends
`error_code` and `error_message`, as null. The two webhook messages built from `decideWebhook`'s reasons are the
500 answers (`no webhook secret`, `missing config`); `already sent` is only logged.

## Configuration

- No new variable names. The studio and the landing page reuse the two public PostHog variables
  (`NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST`); the landing page sends only in
  production, so its previews send nothing.
- The worker reads `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` from `apps/worker/.env.production`,
  the same variables as its events.
- `apps/studio/test-support/worker.ts` blanks `POSTHOG_PROJECT_TOKEN` for every spawned `once`, so a
  filled env file can never make a spec send an exception.
- The comments in `apps/studio/.env.example`, `apps/web/.env.example` and `apps/worker/.env.example`
  say the same variables also turn on error tracking.
- The PostHog project must have error tracking enabled.

## Testing

- Unit (`yarn test`): `apps/studio/src/lib/error-tracking.test.ts` (gate, scrub, `reportFailure`,
  `captureRequestError`, `requestUserId`), `apps/studio/src/lib/upload-server.test.ts` (each upload
  failure captured through `Deps.errors`), `apps/studio/src/lib/server-failures.test.ts` (no
  `console.error(` left under `src/app/` and `src/lib/`), `apps/studio/src/lib/track.test.ts`
  (`captureException` and its test hook), `apps/studio/src/lib/upload-answers.test.ts`,
  `apps/web/src/lib/error-tracking.test.ts`, `apps/worker/src/error-tracking.test.ts` (including the
  closed gate), the failure log record and INFO stderr in `apps/worker/src/telemetry.test.ts`, and
  the capture test in `apps/worker/src/step-runner.test.ts`.
- E2E: the "Create fails" test in `apps/studio/e2e/multipart-upload.spec.ts` sees exactly one
  `$exception` with `status: 500` and `error_code: "failed"` through the test hook.
- Every test uses a fake client; no test calls PostHog.

## Rules

- Never send a secret, a signed URL, an email address, a file name, file contents or a change
  request's text.
- Never pass the provider's error as `cause`: send its code and its scrubbed message as properties.
- Never build a client at module load, or without both variables (and, for the landing page,
  production).
- Tests never call PostHog: fake clients only.
- Never capture to PostHog under `navigator.webdriver`: the test hook records instead.
- Never use the email as the distinct id: the Supabase user id only.
- A new handled server failure in the studio or the landing page goes through `reportFailure`, never
  a bare `console.error`.
- Never rename a stable message once shipped: it is the PostHog issue's grouping key.
- The failure log record never holds a secret, an env value or a request's text, and never breaks a
  job.
- Never write a failure as an ERROR log record anywhere but `emitFailureLog`: a tool's stderr line is
  INFO.

## Notes

- Source map upload is out of scope: it needs a PostHog personal API key in Vercel, a later owner
  step. Until then server stacks are the built ones.
- The Uppy workaround: `@uppy/aws-s3` 6.3.0's Companion client throws only
  `Companion request failed: <statusText>` (empty over HTTP/2), losing the status and the JSON
  `error` code, so the uploader observes its own answers. Re-check it on an Uppy upgrade.
- Studio previews built with the token also send server exceptions (the studio's gate has no
  production check).
- The E2E server has no token, so the server capture of a real R2 refusal is proven by the unit test,
  not by a spec.
- `digest` ties a PostHog issue to the Vercel log line of the same request.
- Neighbouring docs: `app_docs/measurement.md` (events, logs and traces) and `app_docs/upload.md`
  (the upload routes).
