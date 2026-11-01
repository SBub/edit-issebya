# Reel studio: /studio zone, login, reels list, upload, job queue and worker

**Specifications:**

- specs/issue-27-adw-c95d56bf-sdlc_planner-studio-zone-login-reels-list.md
- specs/issue-43-adw-eff3346d-sdlc_planner-reel-upload-job-queue-worker.md
- specs/issue-65-adw-65eeae69-sdlc_planner-rename-future-dated-migration-guard.md

## Overview

`apps/studio` (`@edit-issebya/studio`) is the reel studio, a second Next.js app served at
`edit.issebya.com/studio` through Next.js multi-zones. The owner signs in with a Supabase magic
link and sees only their own reels, read under row-level security. The skeleton covers login, a
reels list, an upload straight to Cloudflare R2, a job queue with a lease, a worker on the owner's
machine (`apps/worker`) and a reel page that follows the job live through Realtime.

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
  Read once on the server, then handed to `LiveReel`.
- `apps/studio/src/lib/reels.ts`: named column lists (never `*`), status type, id check and
  formatters.

### Upload

- `apps/studio/src/app/upload-actions.ts`: `createUpload` validates the request
  (`apps/studio/src/lib/upload.ts`: name, size up to 5 GiB (R2's single-PUT limit), `video/` type,
  extension `mp4`, `mov`, `m4v` or `webm`), inserts the `reels` row (`uploading`) through the
  user's own client and returns a presigned PUT URL. The browser PUTs the file straight to R2;
  the studio's server never sees the body. `finishUpload` calls the `finish_upload` database
  function.
- `apps/studio/src/components/UploadForm.tsx`: the "Clip" input and "Upload" button; on success it
  goes to `/reels/<id>`.
- The key is `<R2_KEY_PREFIX>reels/<reel id>/source/original.<ext>`. The insert policy
  `reels: owner inserts own uploading reel` only accepts a key ending with that reel's own path.
- `finish_upload(p_reel_id, p_bytes)` (`security definer`, executable by `authenticated` only)
  moves the owner's `uploading` reel to `uploaded`, records `source_bytes` and inserts one `process`
  job. Any other caller, reel or state fails the same way.
- `apps/studio/src/lib/storage.ts`: `studioStorage()` returns the fake under `E2E_MOCK_STORAGE`,
  R2 with the studio keys, or `null` (the form then says uploads are unavailable).

### Jobs, steps and the lease

- `supabase/migrations/20261031174750_job_queue.sql`: tables `jobs` (starting with kind `process`, status
  `queued | running | done | failed`, lease holder and expiry, attempts, error tail) and `steps`
  (name, status, summary, error tail), both with owner-only `select` RLS and in the
  `supabase_realtime` publication. Only the worker (secret key) writes job and step state.
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
- `claim_job(p_worker, p_lease_seconds)`: one statement picks the oldest `queued` job, or a
  `running` one whose lease expired, with `for update skip locked`, then takes the lease and counts
  an attempt. Only `service_role` may execute it. There is no retry limit yet.
- The worker renews its lease while it works (`apps/worker/src/lease.ts`); a failed renewal aborts
  the work and writes nothing more, since another worker may hold the job.
- `supabase/migrations/20261101153653_versions.sql`: table `versions` (per-reel `number`, parent,
  restored-from, request, model, prompt version, change summary, checks, input fingerprints,
  `r2_key`), owner-only `select` RLS for `authenticated`, no `anon` access, rows refused on update
  by the `versions_refuse_update` trigger (immutable), in the `supabase_realtime` publication;
  `reels.current_version_id` points at the current one. Written only through `save_version`, which
  only `service_role` (the worker) may execute; details in `app_docs/edit-model.md`.

### Live status

- `apps/studio/src/components/LiveReel.tsx`: renders status, jobs (`job-status`) and the step log
  (`step-line`). One Realtime channel listens to `reels`, `jobs` and `steps` for that reel. When the
  subscription reports ready it does one catch-up read and sets `data-realtime="ready"`. No timer,
  no polling.
- `apps/studio/src/lib/jobs.ts`: named column lists (no lease columns), status lists and
  `upsertById`. `apps/studio/src/lib/supabase-browser.ts`: the browser client, created inside the
  component.

### Worker

- `apps/worker` (`@edit-issebya/worker`) is TypeScript run directly by Node 24 on the owner's
  machine, never on Vercel. Scripts: `worker`, `worker:prod` (long-running), `once` (claim one job,
  used by specs) and `doctor` (checks Supabase, R2, ffmpeg and one structured `claude -p` call).
  Each loads `.env.development` or `.env.production` from `apps/worker/` when present.
- `apps/worker/src/main.ts`: wakes on Realtime `INSERT` into `jobs`, also checks every
  `WORKER_POLL_INTERVAL_SECONDS` reading only job ids, skips claiming when free disk is below
  `WORKER_MIN_FREE_DISK_GB`, runs one job at a time (`loop.ts`).
- `apps/worker/src/steps/receive.ts`: the one placeholder step. It HEADs the source in R2, writes a
  step `footage received, 12.3 MB`, and `run-job.ts` then marks the job `done` and the reel
  `received` (or `failed` with an error tail).

### Storage and AI doubles

- `packages/storage` (`@edit-issebya/storage`, TypeScript source, no build): the `Storage`
  interface, the R2 implementation and a folder fake, shared by the studio and the worker. Each app
  passes its own keys.
- `E2E_MOCK_STORAGE=true` (exactly) makes both use the gitignored `.e2e-storage/` folder at the
  repository root; the studio's `/studio/api/e2e-storage-mock/[...key]` route stands in for R2's
  PUT and answers 404 otherwise. `E2E_MOCK_AI=true` replaces `claude -p` with a scripted answer.
  `E2E_MOCK_RENDER=true` (exactly) replaces the HyperFrames render with a copy of
  `fixtures/render/stub-export.mp4`.
- `fixtures/footage/short-speech.mp4` is the committed short vertical clip with speech, made by
  `scripts/make-test-clip.sh` (macOS only, run by hand).

## How to Use

1. Start the shared local Supabase stack (the owner does this) and apply migrations with
   `supabase migration up --local`. ADW runs use their own local stack (`edit-issebya-adw`, ports
   54450 to 54459, see `app_docs/adw-supabase-stack.md`), which you do not need to start or stop.
2. Fill `apps/studio/.env.development` and `apps/worker/.env.development` from the matching
   `.env.example` files.
3. Run the web and studio dev servers together (see the root `README.md`) and open
   `http://localhost:3000/studio`.
4. Enter an address that already has an account, open the emailed link (local mail: Mailpit), and
   the reels list appears.
5. Pick a clip under "Upload" and press Upload. The reel page opens and shows the job and step log.
6. Run the worker on your machine (`yarn workspace @edit-issebya/worker worker`, see the root
   `README.md`); the page updates without a reload when it finishes the job.
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
  `FFMPEG_PATH`, `E2E_MOCK_AI`, `E2E_MOCK_STORAGE`, `E2E_MOCK_RENDER` (the last three tests only).
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
  `apps/worker/src/**/*.test.ts` and `packages/storage/src/**/*.test.ts` (`yarn test`).
- DB integration: `apps/studio/db-tests/` (`yarn test:db`): RLS on every public table, owner
  isolation, the upload path and `finish_upload`, `claim_job`'s lease (`jobs.test.ts`), `save_version`, version immutability and its RLS
  (`versions.test.ts`), Realtime
  follows RLS for `reels` and `steps`. Needs the local stack (in ADW runs, the ADW stack through
  `SUPABASE_DB_URL` and the other hook variables); not in the pre-push hook.
- E2E: `apps/studio/e2e/` (`login`, `reels`, `forwarding`, `upload` specs, chromium, through the
  landing address), run after the landing suite by `yarn test:e2e`. `upload.spec.ts` uploads the
  test clip, spawns the worker's `once` and expects the page to update without a reload.

## Rules

- Do not use `SUPABASE_SECRET_KEY` in `apps/web` or in `apps/studio/src/`; only
  `apps/studio/test-support/` and `apps/worker` read it. Never use the R2 worker keys
  (`R2_WORKER_ACCESS_KEY_ID`, `R2_WORKER_SECRET_ACCESS_KEY`) in `apps/web` or `apps/studio/src/`.
- Do not point a test at anything but `127.0.0.1` or `localhost` (the helpers refuse other hosts).
- Do not create a user from the login form (`shouldCreateUser` stays `false`) and do not make its
  answer depend on whether the address has an account.
- Do not grant `authenticated` `update` or `delete` on `reels`, nor `insert` beyond `id`,
  `source_name` and `source_key` under the uploading-only policy; no `anon` access.
- Never give the owner a general right to write `status`; finishing an upload goes only through
  `finish_upload`.
- Never let `authenticated` or `anon` execute `claim_job`, or `anon` execute `finish_upload`.
- Never let `authenticated` or `anon` execute `save_version`; versions are written only through
  it, by the service role (the worker), and never updated.
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

## Notes

- Spans `apps/studio`, `apps/worker`, `packages/storage`, `apps/web` (rewrites only), `supabase/`,
  CI and the ADW profile; most of the change is in `apps/studio`.
- Processing, edits and render steps, resumable upload (single PUT only) and a retry limit are
  later slices; the `receive` step is a placeholder.
- The magic-link template takes effect after the local Supabase stack restarts.
