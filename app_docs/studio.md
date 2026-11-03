# Reel studio: /studio zone, login, reels list, upload, job queue and worker

**Specifications:**

- specs/issue-27-adw-c95d56bf-sdlc_planner-studio-zone-login-reels-list.md
- specs/issue-43-adw-eff3346d-sdlc_planner-reel-upload-job-queue-worker.md
- specs/issue-65-adw-65eeae69-sdlc_planner-rename-future-dated-migration-guard.md
- specs/issue-136-adw-0c90e622-sdlc_planner-delete-reel-from-list.md

## Overview

`apps/studio` (`@edit-issebya/studio`) is the reel studio, a second Next.js app served at
`edit.issebya.com/studio` through Next.js multi-zones. The owner signs in with a Supabase magic
link and sees only their own reels, read under row-level security. The skeleton covers login, a
reels list, an upload straight to Cloudflare R2, a job queue with a lease, a worker on the owner's
machine (`apps/worker`) and a reel page that follows the job live through Realtime. Beside the
reels the studio holds the owner's photo library, each photo described by Claude on upload
(`app_docs/photo-library.md`).

## How it works

### Zone and forwarding

- `apps/studio/next.config.ts`: `basePath: "/studio"` and `assetPrefix: "/studio-static"`. The
  asset prefix must equal `STUDIO_ASSET_PREFIX` in the landing page. `NEXT_PUBLIC_SITE_URL`, when
  set, adds its host to the Server Actions `allowedOrigins`.
- `apps/web/src/lib/studio-rewrites.ts`: `studioOrigin` (`STUDIO_URL`, else
  `http://localhost:$STUDIO_PORT`, default 3001) and `studioRewrites` (`/studio`, `/studio/:path+`
  and `/studio-static/:path+`), used by `apps/web/next.config.ts`. Read at build time.
- The studio is never opened on its own port: it is reached through the landing page's address.

### Login

- `apps/studio/src/app/actions.ts`: `sendMagicLink` validates the address, then calls
  `signInWithOtp` with `shouldCreateUser: false`. The answer is the same for a known address, an
  unknown one and a rate limit, so the form never reveals who has an account; an error is logged
  without the address. `signOut` ends the session and redirects to `/studio`.
- `apps/studio/src/lib/confirm-url.ts`: the link's target, `<origin>/studio/auth/confirm`.
  `NEXT_PUBLIC_SITE_URL` wins, otherwise `x-forwarded-proto` and `x-forwarded-host` (so a run on
  any port stays right), otherwise `host`.
- `apps/studio/src/app/auth/confirm/route.ts`: verifies the token hash (`type` `email` or
  `magiclink`) and answers a 303 with a relative `Location` (`/studio`, or `/studio?error=link`
  for a bad or used link). Relative, because behind the rewrite `request.url` carries the studio's
  internal host.
- `supabase/templates/magic-link.html` and the `[auth.email.template.magic_link]` block of
  `supabase/config.toml`: the email carries `{{ .RedirectTo }}?token_hash=...&type=email`.
- `apps/studio/src/proxy.ts`: refreshes the session cookie on every page request (the
  `@supabase/ssr` pattern); a no-op when the studio is not configured. Pages still check the user.
- `apps/studio/src/lib/supabase-server.ts`: one server client per request, never at module load,
  so `next build` needs no variables. `apps/studio/src/lib/supabase-config.ts` returns `null`
  without the two public variables; every page then shows `NotConfigured`.

### Reels

- `supabase/migrations/20261031105245_studio_skeleton.sql`: table `public.reels` (owner, status
  `uploading | uploaded | received | failed`, source key, bytes, name, timestamps), an
  `updated_at` trigger, RLS with one `select` policy for the owner, `anon` revoked, and
  `authenticated` limited to `select`. The table is in the `supabase_realtime` publication.
- `apps/studio/src/app/page.tsx`: signed out shows `LoginForm`; signed in shows `ReelList`,
  newest first, with `UploadForm` above it. No owner filter in the query: RLS alone scopes the
  rows, so a missing policy is never masked.
- `apps/studio/src/app/reels/[id]/page.tsx`: one reel with its jobs and steps. A malformed id
  (`isReelId`) or a reel that is not the caller's is a 404; signed out redirects to `/studio`.
  Read once on the server, then handed to `LiveReel`. A deleted reel's page is the same 404,
  `Reel not found` (`not-found.tsx`).
- `supabase/migrations/20261103201352_reel_deletion.sql`: `delete_reel(p_reel_id)` (`security
definer`, executable by `authenticated` only, revoked from `public`, `anon` and `service_role`).
  It locks the caller's own reel (`owner_id = auth.uid()`, `for update`), else raises `P0002`,
  queues every key the reel stored and its source in `storage_deletions`, then deletes the reel;
  versions, jobs, steps, change requests, exports and `stored_files` rows go through the existing
  cascades. The objects are removed later by the worker (`app_docs/storage.md`, "Deleting a reel").
- `apps/studio/src/lib/reel-server.ts` `deleteReel`: checks the id, answers signed-out or
  unavailable, maps `P0002` to `not-found`, and captures any other error as
  `studio: reel not deleted` and answers `failed`. `apps/studio/src/app/reel-actions.ts` is the
  server action that calls it.
- `apps/studio/src/components/DeleteReelButton.tsx`: the bin in each reels tile's bottom-right
  corner (accessible name `Delete reel`, always visible, 44 px on a phone, 32 px from `sm`): a
  plain bin in ink with no background or shape, square like the rest of the studio
  (`app_docs/studio-reel-layout.md`). It opens a native square `<dialog>`: `Delete this reel? Its versions and files are removed and cannot be
restored` with Cancel and Delete. Cancel, Escape and the backdrop change nothing. After a delete,
  or when the reel was already gone, `router.refresh()` drops it from the list at once; a failure
  stays in the dialog as an alert.
- `apps/studio/src/lib/reels.ts`: named column lists (never `*`), status type, id check and
  formatters.

### Upload

- The key is `<R2_KEY_PREFIX>reels/<reel id>/source/original.<ext>`. The insert policy
  `reels: owner inserts own uploading reel` only accepts a key ending with that reel's own path.
- `apps/studio/src/lib/storage.ts`: `studioStorage()` returns the fake under `E2E_MOCK_STORAGE`,
  R2 with the studio keys, or `null` (uploads then answer unavailable).
- The resumable multipart upload (`UploadForm`, the uploader, the routes under
  `apps/studio/src/app/api/uploads/s3/multipart/`, `finish_upload`, `fail_upload`,
  `source_upload_id`, resume) is described in `app_docs/upload.md`.

### Jobs, steps and the lease

- `supabase/migrations/20261031174750_job_queue.sql`: tables `jobs` (starting with kind `process`, status
  `queued | running | done | failed`, lease holder and expiry, attempts, error tail) and `steps`
  (name, status, summary, error tail), both with owner-only `select` RLS and in the
  `supabase_realtime` publication. Only the worker (secret key) writes job and step state.
- `supabase/migrations/20261101233625_storage_records.sql`: tables `stored_files` (one row per
  stored object and reel) and `worker_status` (why a worker is not claiming), see
  `app_docs/storage.md`.
- `supabase/migrations/20261101184843_change_restore_jobs.sql`: `jobs` then had three kinds,
  `process`, `change` (carries the owner's words in `request`, 1 to 1000 trimmed characters) and
  `restore` (names an earlier version of the same reel in `restore_version_id`). Owners insert jobs
  on two paths: the `process` policy (`jobs: owner inserts a process job for own reel`; an upload
  queues its process job through `finish_upload`) and `jobs: owner inserts a change or restore job
for own reel`, through a column-limited grant (`reel_id`, `kind`, `request`, `restore_version_id`);
  status, lease, attempt and error columns stay the worker's. See `app_docs/change-requests.md`.
- `supabase/migrations/20261101194557_export_render_jobs.sql`: the fourth kind, `render` (kinds
  `process`, `change`, `restore`, `render`), names the version to export in `version_id` (required
  exactly for a render). A third owner insert path, `jobs: owner inserts a render job for own reel`
  (grant on `version_id`). The `exports` table holds each finished render: owner-only `select`,
  written only by the worker, in `supabase_realtime`. See `app_docs/export.md`.
- `supabase/migrations/20261102191719_photo_library.sql`: table `public.photos` (owner, `r2_key`,
  `upload_id`, file name, content type, size and dimensions, status `uploading`, `describing`,
  `ready` or `failed`, description, tags, model, prompt version, `thumbnail_key`, `large_key`;
  owner-only `select` and a column-limited `insert` of an `uploading` row; in `supabase_realtime`).
  The sixth job kind, `describe_photo`. `reel_id` is now nullable on `jobs`, `steps` and
  `stored_files`, each with a `photo_id` beside it (`on delete cascade`) and a check that exactly one
  is set (`jobs_target_check` also ties `describe_photo` to `photo_id`). Owners never insert a
  `describe_photo` job directly: `finish_photo_upload` queues it. `claim_job` keeps one job per reel
  or per photo at a time. See `app_docs/photo-library.md`.
- `supabase/migrations/20261103115809_failure_kind_reel_size.sql`: `jobs.failure_kind`
  (`transient`, `failed` or `answer_refused`, only on a `failed` job) and `jobs.failure_rules` (a
  refused answer's check rule names), and the `reels` size columns `source_seconds`,
  `source_width`, `source_height` and `word_count`, each written once by the worker while null. The
  owner reads them all and writes none. See `app_docs/failures.md` and `app_docs/measurement.md`.
- `supabase/migrations/20261103164248_one_step_export.sql`: job status `cancelled`, set only by
  `cancel_job(p_job_id)` (`security definer`, `authenticated` may execute, never `anon`): the owner
  of the reel cancels their own `render` job while it is `queued`, `running` or `waiting_ai` and has
  no export. Exports now expire 1 hour after they are made. See `app_docs/export.md`.
- `claim_job(p_worker, p_lease_seconds)`: one statement picks the oldest `queued` job, or a
  `running` one whose lease expired, with `for update skip locked`, then takes the lease and counts
  an attempt. Only `service_role` may execute it. It takes one job per reel at a time, in order,
  and skips a `waiting_ai` job until its `not_before` (see `app_docs/failures.md`). It never
  claims a `cancelled` job.
- The worker renews its lease while it works (`apps/worker/src/lease.ts`); a failed renewal aborts
  the work and writes nothing more, since another worker may hold the job. A render job also
  checks every 5 seconds whether its owner cancelled it, and a cancel aborts the work the same
  way.
- A job whose reel or photo was deleted stops with `JobGone`: `keepLease` (`lease.ts`) takes a
  `gone` check (`process-job.ts` passes `jobGone` from `queue.ts`), and a renewal that matched no
  row asks whether the job's row is gone and aborts with `JobGone` instead of a lost lease, so the
  job stops within one lease renewal and the tool's process group is killed (`checkGone()`,
  `isJobGone()`). `run-job.ts` then ends it with outcome `deleted` and one log line
  `job <id>: reel deleted, stopped` (`photo deleted` for a photo job), also when a final write
  matched no row: nothing more is written, no failed row and no capture. `withStep`
  (`step-runner.ts`) does not fail a step while `checkGone` says the row is gone.
- `supabase/migrations/20261101153653_versions.sql`: table `versions` (per-reel `number`, parent,
  restored-from, request, model, prompt version, change summary, checks, input fingerprints,
  `r2_key`), owner-only `select` RLS for `authenticated`, no `anon` access, rows refused on update
  by the `versions_refuse_update` trigger (immutable), in the `supabase_realtime` publication;
  `reels.current_version_id` points at the current one. Written only through `save_version`, which
  only `service_role` (the worker) may execute; details in `app_docs/edit-model.md`.

### Table grants

- The hosted project's default privileges for tables `postgres` creates in `public` give `anon`,
  `authenticated` and `service_role` only `references`, `trigger`, `truncate` and `maintain`, and
  nothing on sequences or functions. A table no migration grants anything is unreadable by every
  API role there, the service role included.
- `supabase/migrations/20261102121556_service_role_table_grants.sql`: `service_role` (the worker)
  gets `select`, `insert`, `update`, `delete` on every public table, and the local stack's default
  privileges are cut down to the hosted ones (and the trigger functions' leftover local `execute`
  grants removed), so local grants after a reset equal hosted's. Before it the local defaults
  granted all, and the worker failed on hosted with `permission denied for table jobs` while every
  local test passed.
- `storage_deletions` (`20261103201352_reel_deletion.sql`) has RLS on with only a `service_role`
  policy, `anon` and `authenticated` revoked, and `service_role` its four data privileges. Its
  functions are `service_role` only; `delete_reel` is `authenticated` only.

### Live status

- `apps/studio/src/components/LiveReel.tsx`: renders no status panel, jobs list or step log. One
  Realtime channel listens to `reels`, `jobs` and `steps` (and the reel's versions and exports, and
  `worker_status`) for that reel; the same channel feeds the progress overlay over the preview
  (`app_docs/status.md`). When the subscription reports ready it does one catch-up read and sets
  `data-realtime="ready"`. No timer, no polling. The reel's machine status shows only on the reels
  grid's badge (`reel-list-status`); specs read the reel's, jobs' and steps' statuses from the
  database through `apps/studio/test-support/rows.ts`.
- The reel page also carries the photo library (`PhotoLibrary`, its own Realtime channel on
  `photos`): the third desktop column and the phone's Library tab (`app_docs/studio-reel-layout.md`).
- `apps/studio/src/lib/jobs.ts`: named column lists (no lease columns), status lists and
  `upsertById`. `apps/studio/src/lib/supabase-browser.ts`: the browser client, created inside the
  component.

### Worker

- `apps/worker` (`@edit-issebya/worker`) is TypeScript run directly by Node 24 on the owner's
  machine, never on Vercel. Scripts: `worker`, `worker:prod` (long-running), `once` (claim one job,
  used by specs) and `doctor` (checks Supabase, R2 read and write access through a probe it puts,
  reads back and deletes under `<R2_KEY_PREFIX>doctor/`, the scratch folder, which must exist or be
  creatable and which it never creates, ffmpeg and one structured `claude -p` call). Each loads
  `.env.development` or `.env.production` from `apps/worker/` when present. `worker`,
  `worker:prod` and `once` create the scratch folder (`WORKER_SCRATCH_DIR`) at start-up and exit 1
  when they cannot (see `app_docs/storage.md`).
- `apps/worker/src/main.ts`: wakes on Realtime `INSERT` into `jobs`, also checks every
  `WORKER_POLL_INTERVAL_SECONDS` reading only ids (a claimable job's, and one due `storage_deletions`
  row's under its prefix), skips claiming below
  `WORKER_MIN_FREE_DISK_GB` and records the reason in `worker_status`, which the reel page's
  overlay shows for a queued job, slims storage at most hourly between jobs, removes each job's scratch folder
  and runs one job at a time (`loop.ts`). Before each claim it runs the deletion pass
  (`storage-deletions.ts`), and the poll signals the drainer when a due `storage_deletions` row
  waits and no job does (it reads only that row's `id` and never writes; held keys are dropped by
  the pass); `once` never runs it. See `app_docs/storage.md`.
- `apps/worker/src/steps/receive.ts`: the one placeholder step. It HEADs the source in R2, writes a
  step `footage received, 12.3 MB`, and `run-job.ts` then marks the job `done` and the reel
  `received` (or `failed` with an error tail).

### Storage and AI doubles

- `packages/storage` (`@edit-issebya/storage`, TypeScript source, no build): the `Storage`
  interface, the R2 implementation and a folder fake, shared by the studio and the worker. Each app
  passes its own keys.
- `E2E_MOCK_STORAGE=true` (exactly) makes both use the gitignored `.e2e-storage/` folder at the
  repository root; the studio's `/studio/api/e2e-storage-mock/[...key]` route stands in for R2's
  upload part `PUT` (part requests only, see `app_docs/upload.md`) and answers 404 otherwise. `E2E_MOCK_AI=true` replaces `claude -p` with a scripted answer.
- `E2E_MOCK_STEPS=true` (exactly) is the pipeline step double: a fixed step that must run copies
  its committed output from `fixtures/pipeline/` instead of running its tool, and
  `E2E_MOCK_STEP_FAULT` makes one step fail on purpose. See `app_docs/failures.md`.
  `E2E_MOCK_RENDER=true` (exactly) replaces the HyperFrames render with a copy of
  `fixtures/render/stub-export.mp4`.
- `fixtures/footage/short-speech.mp4` is the committed short vertical clip with speech, made by
  `scripts/make-test-clip.sh` (macOS only, run by hand).

## How to Use

1. Fill `apps/web/.env.development`, `apps/studio/.env.development` and
   `apps/worker/.env.development` from the matching `.env.example` files.
2. Create the owner account in the local auth once: `yarn dev:studio add-owner <email>`.
3. Run `yarn dev:studio` from the repository root (see the root `README.md`): it checks Docker,
   starts the local Supabase stack if it is down, applies the migrations, runs the worker doctor,
   then runs the web and studio dev servers and the worker together. Open
   `http://localhost:3000/studio`. ADW runs use their own local stack (`edit-issebya-adw`, ports
   54450 to 54459, see `app_docs/adw-supabase-stack.md`), which the command never touches.
4. Enter an address that already has an account, open the emailed link (local mail: Mailpit), and
   the reels list appears.
5. Pick a clip under "Upload" and press Upload. The reel page opens and shows the job and step log.
6. The worker started by `yarn dev:studio` takes the job; the page updates without a reload when it
   finishes.
7. For a quick sign-in in tests or review, open the URL printed by
   `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url`.

## Configuration

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`:
  inlined at build; the studio builds and starts without them.
- `STUDIO_URL` and `STUDIO_PORT`: where the landing page forwards `/studio` (`STUDIO_PORT`
  defaults to 3001; the studio's `dev` and `start` use it).
- `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_JURISDICTION`, `R2_STUDIO_ACCESS_KEY_ID`,
  `R2_STUDIO_SECRET_ACCESS_KEY`, `R2_KEY_PREFIX` (studio, read per request at run time), and
  `E2E_MOCK_STORAGE` (tests only).
- Worker (`apps/worker/.env.development`): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `WORKER_ID`,
  `R2_WORKER_ACCESS_KEY_ID`, `R2_WORKER_SECRET_ACCESS_KEY`, `WORKER_POLL_INTERVAL_SECONDS`
  (default 120), `WORKER_MIN_FREE_DISK_GB` (default 10), `WORKER_SCRATCH_DIR`, `CLAUDE_CODE_PATH`,
  `FFMPEG_PATH`, `E2E_MOCK_AI`, `E2E_MOCK_STORAGE`, `E2E_MOCK_RENDER`, `E2E_MOCK_FREE_DISK_GB` (the
  last four tests only).
- `SUPABASE_SECRET_KEY` is read only by the worker and by the test helpers in
  `apps/studio/test-support/`, from `apps/worker/.env.development`.
- `SUPABASE_DB_URL`: test helpers only (`localDbUrl` in `apps/studio/test-support/local-supabase.ts`),
  the direct database URL the DB tests query; defaults to the shared stack's 54432 database. In ADW
  runs `.adw/worktree-env` sets it to the ADW stack's.

## Testing

- Unit: `apps/studio/src/lib/*.test.ts`, the storage mock route test,
  `apps/studio/test-support/local-supabase.test.ts`,
  `apps/studio/test-support/migration-versions.test.ts` (the migration version guard: fails on a version
  more than 10 minutes in the future, a version two files share or a malformed prefix; turbo
  re-runs it when `supabase/migrations/` changes), `apps/web/src/lib/studio-rewrites.test.ts`,
  `apps/worker/src/**/*.test.ts` and `packages/storage/src/**/*.test.ts` (`yarn test`), among them
  `reel-server.test.ts` (`deleteReel`), `storage-deletions.test.ts` (the deletion pass) and
  `reel-deleted.test.ts` (a job whose reel is deleted ends `deleted`).
- DB integration: `apps/studio/db-tests/` (`yarn test:db`): RLS on every public table, owner
  isolation, the upload path and `finish_upload`, `claim_job`'s lease (`jobs.test.ts`), `save_version`, version immutability and its RLS
  (`versions.test.ts`), `stored_files`, `worker_status`, the slimming, export expiry and
  `finish_upload`'s source row (`stored-files.test.ts`), Realtime follows RLS for `reels` and `steps`, and the grants
  (`grants.test.ts`: `service_role`'s four data privileges on every public table, no `anon`
  privilege on any, no table-wide write for `authenticated`, and default privileges as on hosted),
  and the `photos` table (`photos.test.ts`: RLS, insert policy, status and ready checks,
  `finish_photo_upload`, `delete_photo`, `record_photo_file` and `jobs_target_check`), and
  `reel-deletion.test.ts` (`delete_reel` owner only, the cascade, every key queued,
  `record_stored_file` on a deleted reel and the `storage_deletions` queue's functions).
  Needs the local stack (in ADW runs, the ADW stack through
  `SUPABASE_DB_URL` and the other hook variables); not in the pre-push hook.
- E2E: `apps/studio/e2e/` (`login`, `reels`, `forwarding`, `upload`, `multipart-upload`, `disk-guard` specs, chromium, through the
  landing address), run after the landing suite by `yarn test:e2e`. `upload.spec.ts` uploads the
  test clip, spawns the worker's `once` and expects the page to update without a reload, then checks one `stored_files` row per stored object.
  `disk-guard.spec.ts` covers the waiting reason (`app_docs/storage.md`). `multipart-upload.spec.ts` covers parts, a
  retried part, resume, ownership and cancel (details in `app_docs/upload.md`).
  `delete-reel.spec.ts` shows the bin on every tile at 1440x900 and 390x844, checks that Cancel and
  Escape keep the reel, and that Delete removes it and its queued job without a reload, queues its
  source key in `storage_deletions` and leaves its page `Reel not found`.

## Rules

- Do not use `SUPABASE_SECRET_KEY` in `apps/web` or in `apps/studio/src/`; only
  `apps/studio/test-support/` and `apps/worker` read it. Never use the R2 worker keys
  (`R2_WORKER_ACCESS_KEY_ID`, `R2_WORKER_SECRET_ACCESS_KEY`) in `apps/web` or `apps/studio/src/`.
- Do not point a test at anything but `127.0.0.1` or `localhost` (the helpers refuse other hosts).
- Do not create a user from the login form (`shouldCreateUser` stays `false`) and do not make its
  answer depend on whether the address has an account.
- Do not grant `authenticated` `update` or `delete` on `reels`, nor `insert` beyond `id`,
  `source_name`, `source_key` and `source_upload_id` under the uploading-only policy; no `anon`
  access.
- Never give the owner a general right to write `status`; finishing an upload goes only through
  `finish_upload`, cancelling one only through `fail_upload`, cancelling a render job only through
  `cancel_job`.
- Never let `authenticated` or `anon` execute `claim_job`, or `anon` execute `finish_upload`,
  `fail_upload` or `cancel_job`.
- Never let `authenticated` or `anon` execute `save_version`; versions are written only through
  it, by the service role (the worker), and never updated.
- Only the owner deletes a reel, and only through `delete_reel`; never delete a `reels` row any
  other way.
- A job whose reel or photo was deleted is never a failure: it ends `deleted`, writes no failed row
  and captures nothing.
- Never poll from the studio; the reel page reads on open and on each ready subscription only.
- Never read more than `id` in the worker's periodic check.
- Never put large content in rows (files in R2, logs in PostHog).
- Never store video in Supabase Storage; footage goes from the browser straight to R2.
- Never turn a double on unless its flag is exactly `"true"`; its route answers 404 otherwise.
- Never name a worker script `dev` or `start`; never start the worker except through a spec's
  `once` in a run.
- Never create an R2 or Supabase client at module load.
- Never stage `.e2e-storage/`; never touch `fixtures/footage/short-person.mp4`.
- Never point a test at real R2, a real AI or the hosted project.
- Do not select `*` from `reels`; name the columns.
- Do not change `assetPrefix` on one side only: it must equal `STUDIO_ASSET_PREFIX`.
- Do not return an absolute `Location` from the confirm route.
- Never future-date or reuse a migration version; `migration-versions.test.ts` enforces it.
- Never create a public table without explicit grants per role in the same migration: `service_role`
  its `select`, `insert`, `update`, `delete`, `authenticated` only what its RLS policies need, and
  `revoke all ... from anon` (hosted defaults give `anon` `truncate`). Never rely on default
  privileges, and never widen the local defaults again: they must match hosted (`grants.test.ts`).

## Notes

- Spans `apps/studio`, `apps/worker`, `packages/storage`, `apps/web` (rewrites only), `supabase/`,
  CI and the ADW profile; most of the change is in `apps/studio`.
- Processing, edits and render steps are later slices; the `receive` step is a placeholder.
- The magic-link template takes effect after the local Supabase stack restarts.
