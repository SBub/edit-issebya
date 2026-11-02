# Patch: add the error-tracking feature doc, its index line and the measurement.md pointers

## Metadata

adw_id: `961010ec`
review_change_request: `Issue #1: Step 11 (Documentation) and its acceptance criterion are not in the diff. app_docs/error-tracking.md does not exist, docs/conditional-docs.md has no line for it, and app_docs/measurement.md has no pointer to it. The test-hook line in measurement.md is also not updated, even though the hook now records $exception from the upload form. Resolution: edit app_docs/measurement.md (pointer under Studio analytics and under Telemetry, $exception on the test hook line), create app_docs/error-tracking.md with the sections step 11 lists, add its line to docs/conditional-docs.md, no em-dashes, run yarn format. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-90-adw-961010ec-sdlc_planner-posthog-error-tracking.md`
**Issue:** Step 11 of the spec was not implemented. `app_docs/error-tracking.md` is missing,
`docs/conditional-docs.md` has no line for it, and `app_docs/measurement.md` neither points to it
nor says that the studio test hook (`src/lib/track.ts`) now also records `$exception` from the
upload form through `captureException`. The acceptance criterion "`app_docs/error-tracking.md`
exists, `docs/conditional-docs.md` has its line, `app_docs/measurement.md` points to it" fails.
**Solution:** Documentation only, no code change. Write the feature doc from the code already on
this branch (the stable messages below are the literal strings in the code), add its one index
line, add the two pointers and the `$exception` mention to `measurement.md`, then `yarn format`.

## Files to Modify

Use these files to implement the patch:

- `app_docs/error-tracking.md` (new)
- `docs/conditional-docs.md` (one new line)
- `app_docs/measurement.md` (two pointer lines and one sentence on the test hook)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Re-read the shipped code the doc describes

- Read `apps/studio/src/lib/error-tracking.ts`, `apps/studio/src/instrumentation.ts`,
  `apps/studio/src/lib/track.ts`, `apps/studio/src/lib/upload-answers.ts`,
  `apps/studio/src/lib/uploader.ts`, `apps/studio/src/components/UploadForm.tsx` (line ~137),
  `apps/web/src/lib/error-tracking.ts`, `apps/web/src/instrumentation.ts`,
  `apps/worker/src/error-tracking.ts`, `apps/worker/src/step-runner.ts`, `apps/worker/src/main.ts`,
  `apps/worker/src/once.ts`, `apps/studio/test-support/worker.ts` and the three `.env.example`
  files, so every name, property and variable in the doc matches the code (verify each one;
  never describe something the code does not do).
- Confirm the stable messages with
  `grep -rn -A3 "reportFailure(" apps/studio/src apps/web/src | grep message`. On this branch they are:
  - studio upload server (`src/lib/upload-server.ts`): `studio: upload reel not read`,
    `studio: multipart upload not created`, `studio: reel not created`,
    `studio: upload not finished`, `studio: upload not failed` (properties `error_code`,
    `error_message`, `reel_id` where known, user id as `distinct_id`).
  - studio actions: `studio: magic link not sent` (`actions.ts`, `error_code` only, never the
    email), `studio: reel not read for a change` and `studio: <kind> job not queued`
    (`change-actions.ts`, never the request text), `studio: job not read for a retry` and
    `studio: retry not queued` (`retry-actions.ts`), `studio: reel not read for an export`,
    `studio: render job not queued`, `studio: export not read`, `studio: export key refused`,
    `studio: export link not signed` (`export-actions.ts`, the last sends the error name only),
    `studio: preview not signed` (`preview-actions.ts`), each with `reel_id`.
  - web: `startCheckout: no Stripe secret key is configured`, `startCheckout: session without a url`,
    `startCheckout: creating the Checkout Session failed` (`app/actions.ts`);
    `stripe webhook: missing config` (property `missing_config`, variable names only),
    `stripe webhook: signature verification failed`, `stripe webhook: sending failed`,
    `stripe webhook: emails sent but the sent flag was not written`
    (`app/api/stripe/webhook/route.ts`); `currentOfferPrice: counting sold spots failed`
    (`lib/offer-price.ts`). Check the webhook's `${reason}` messages against `decideWebhook`.
  - studio browser: `studio: upload failed` (`UploadForm.tsx`, properties `status`, `error_code`,
    `resumed`; never on cancel).
  - worker: `worker: step failed` (properties `app`, `step`, `job_kind`, `reel_id`, `job_id`,
    `attempt`, `retrying`, `failure_kind` `refused|transient|failed`, `error_code`, `error_tail`
    scrubbed and cut to its last 1000 characters; `distinct_id` the job's `owner_id`) and the
    uncaught crash capture (`kind: "uncaught"`).
  - every Next request error through `onRequestError` (original message scrubbed, properties
    `app`, `path` without query, `method`, `route_path`, `route_type`, `router_kind`,
    `render_source`, `digest`).

### Step 2: Create `app_docs/error-tracking.md`

- Title `# Error tracking (PostHog)`, then `**Specifications:**` listing
  `specs/issue-90-adw-961010ec-sdlc_planner-posthog-error-tracking.md` (the same shape as
  `app_docs/measurement.md`).
- `## Overview`: production failures of the studio (server and browser), the landing page (server)
  and the worker go to PostHog error tracking in project 312096 as `$exception` events, with a
  stable message, `app` (`studio`, `web`, `worker`), the provider's code or name and, where known,
  the Supabase user id as `distinct_id`. Nothing is sent without the variables.
- `## How it works`, with `###` subsections:
  - `### Gate per app`: studio server and browser need `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and
    `NEXT_PUBLIC_POSTHOG_HOST`; web server also `NEXT_PUBLIC_VERCEL_ENV === "production"`; worker
    `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. Read per call, never at module load; a closed gate
    builds no client.
  - `### Studio and landing page server`: `onRequestError` in each `src/instrumentation.ts`
    (Node runtime only, dynamic import, try/catch, awaited `shutdown()` flush, short-lived
    `posthog-node` client with `flushAt: 1`, `flushInterval: 0`); the studio's `requestUserId`
    (`@supabase/ssr`, `auth.getClaims()`, `sub`, never the email). `reportFailure` for handled
    failures: keeps the existing `console.error` log line, captures a new `StudioFailure` /
    `WebFailure` error with the stable message and no `cause`, scrubs every string property,
    flushes. `upload-server.ts` takes it through `Deps.errors`. `scrub` rules (URL query strings,
    the secret prefixes, `Bearer`, JWT-shaped strings, emails, truncation).
  - `### Studio browser`: `captureException` in `src/lib/track.ts` calls
    `posthog.captureException` when PostHog is loaded; `observeUploadAnswers` in
    `src/lib/upload-answers.ts` records the upload route's failing status and `error` during one
    `start()` (why: see Notes); `UploadForm.tsx` captures one `studio: upload failed` per failed
    upload. Uncaught browser errors still come from `capture_exceptions: true`.
  - `### Worker`: `createErrorTracker` built in `main.ts` and `once.ts`, passed through
    `processJob` onto `StepContext.errors`; `withStep` calls `stepFailed` after the failed row is
    written, never on a lost lease or `AiUnavailable`; `installCrashCapture` for
    `uncaughtException` / `unhandledRejection` (capture, bounded `shutdown(3000)`, exit 1); the
    drainer's `onError` calls `crashed`; `shutdown()` beside every `telemetry.shutdown()`.
  - `### Stable messages`: a Markdown table with columns `Message | App | Place | Properties`
    holding every message listed in Step 1 (one row each; the `studio: <kind> job not queued` row
    names its kinds `change` and `restore` only if the code shows that, otherwise keep `<kind>`).
- `## Configuration`: no new variable names. Studio and web reuse the two public PostHog
  variables (web previews send nothing, production only); the worker reads `POSTHOG_PROJECT_TOKEN`
  and `POSTHOG_HOST` from `apps/worker/.env.production`; `apps/studio/test-support/worker.ts`
  blanks `POSTHOG_PROJECT_TOKEN`; the PostHog project must have error tracking enabled; mention the
  `.env.example` comments.
- `## Testing`: unit tests `apps/studio/src/lib/error-tracking.test.ts`,
  `upload-server.test.ts`, `server-failures.test.ts` (no `console.error(` left under `src/app/`
  and `src/lib/`), `track.test.ts`, `upload-answers.test.ts`, `apps/web/src/lib/error-tracking.test.ts`,
  `apps/worker/src/error-tracking.test.ts`, the `step-runner.test.ts` capture test; E2E
  `apps/studio/e2e/multipart-upload.spec.ts` "Create fails" test (one `$exception` with status 500
  and `error_code: "failed"` through the test hook). All with fake clients; no test calls PostHog.
- `## Rules` (each an invariant): never send a secret, signed URL, email address, file name, file
  contents or a change request's text; never pass the provider error as `cause` (send its code and
  scrubbed message as properties); never build a client at module load or without both variables;
  tests never call PostHog (fake clients only); never capture under `navigator.webdriver` (the
  test hook records instead); never use the email as the distinct id; a new handled server failure
  in the studio or the landing page goes through `reportFailure`, never a bare `console.error`;
  never rename a stable message once shipped (it is the PostHog issue's grouping key).
- `## Notes`: source map upload is out of scope (needs a PostHog personal API key in Vercel, a
  later owner step); the Uppy workaround (`@uppy/aws-s3` 6.3.0's Companion client throws only
  `Companion request failed: <statusText>`, empty over HTTP/2, so the uploader observes its own
  answers; re-check on an Uppy upgrade); studio previews built with the token also send server
  exceptions; the E2E server has no token, so the server capture of a real R2 refusal is proven by
  the unit test; `digest` ties a PostHog issue to the Vercel log line; neighbouring docs
  `app_docs/measurement.md` and `app_docs/upload.md`.
- No em-dashes (use commas, colons, parentheses). No dated changelog entries.

### Step 3: Add the index line to `docs/conditional-docs.md`

- Append after the `app_docs/dashboard.md` line, exactly:
  `- Read \`app_docs/error-tracking.md\` when changing \`onRequestError\`, \`reportFailure\` or a handled server failure in the studio or the landing page, the studio's \`captureException\` or the upload failure capture, the worker's error tracker or crash handlers, or what an exception may carry.`

### Step 4: Update `app_docs/measurement.md`

- Under `### Telemetry (\`apps/worker/src/telemetry.ts\`)`, add a last bullet:
`- Exceptions: \`app_docs/error-tracking.md\`.`
- Under `### Studio analytics (\`apps/studio\`)`, add a bullet after the `src/lib/track.ts`bullet:`- Exceptions: \`app_docs/error-tracking.md\`.`
- Extend the `src/lib/track.ts` bullet: it also holds `captureException(message, properties)`, and
  the test hook also records `{ event: "$exception", properties }` (with `app` and
  `$exception_message`) from the upload form's failed upload, via `captureException`.

### Step 5: Format and check for em-dashes

- `yarn format`
- `grep -n $'\xe2\x80\x94' app_docs/error-tracking.md app_docs/measurement.md docs/conditional-docs.md` prints
  nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn knip`
- `test -f app_docs/error-tracking.md && grep -c "app_docs/error-tracking.md" docs/conditional-docs.md app_docs/measurement.md` (1 in the index, 2 in measurement.md) and `grep -n '\$exception' app_docs/measurement.md` shows the test hook line.
- `grep -rn $'\xe2\x80\x94' app_docs/error-tracking.md app_docs/measurement.md docs/conditional-docs.md` prints nothing.
- `yarn turbo run test --filter=./apps/web --filter=./apps/studio --filter=./apps/worker` (regression only; no code changed).

## Patch Scope

**Lines of code to change:** about 150 lines of Markdown (new doc ~140, index 1, measurement.md ~5); no code.
**Risk level:** low
**Testing required:** format check, knip and the unit suites as a regression check; manual check that every name, message and property in the doc matches the code.
