# Feature: reel studio skeleton, part 2 (upload to R2, job queue with lease, worker, live status)

## Metadata

issue_number: `43`
adw_id: `eff3346d`
issue_json: `{"number":43,"title":"feat: reel studio skeleton, part 2: upload to R2, job queue with lease, worker, live status"}`

## Feature Description

The second half of the reel studio's skeleton (slice 4b of 17), on top of #27 (merged as `7b5516e`).
Every part is real but minimal:

- **Upload.** On `/studio`, above the reels list, the owner picks a short clip. A server action
  creates the `reels` row (`uploading`) and returns a presigned PUT URL for one Cloudflare R2
  object; the browser PUTs the file straight to R2 (the studio's server never sees the body); a
  second server action finishes the upload through one narrow database function that moves the
  reel to `uploaded`, records `source_bytes` and inserts one `process` job.
- **Job queue with a lease.** New tables `jobs` and `steps` under owner-only RLS, published to
  Realtime, and a `claim_job` function (`for update skip locked`, lease with expiry, attempts)
  that only `service_role` may execute.
- **Worker.** A new workspace `apps/worker` (`@edit-issebya/worker`), TypeScript run directly by
  Node 24, on the owner's machine (never on Vercel). It wakes on Realtime inserts into `jobs`,
  checks the table every `WORKER_POLL_INTERVAL_SECONDS` reading only ids, claims with a lease it
  renews while working, and runs one placeholder step, `receive` (HEAD the source in R2, write a
  `steps` row `footage received, 12.3 MB`, job `done`, reel `received`). It also has `once` (for
  specs) and `doctor` (Supabase, R2, ffmpeg, one structured `claude -p` call).
- **Live status.** `/studio/reels/<id>` reads the reel, its jobs and its steps once on the
  server, then follows changes through Realtime filtered to that reel. No polling.
- **Test foundations for every later slice.** A storage double (`E2E_MOCK_STORAGE=true`, a fake
  backed by the gitignored `.e2e-storage/` folder, visible to both the studio and the worker), an
  AI double (`E2E_MOCK_AI=true`), a committed few-second vertical test clip with speech
  (`fixtures/footage/short-speech.mp4`) and the script that made it, and the worker's rows in the
  ADW profile.

## User Story

As the owner, signed in to edit.issebya.com/studio
I want to upload a short clip and watch its status change live while the worker on my Mac picks the job up and finishes it
So that the studio has a real, tested path from footage in my browser to a job the worker finishes, that every later slice (processing, edits, render) builds on

## Problem Statement

After #27 the studio can sign in and list reels, but reels can only be inserted by the admin API:
there is no upload, no job table, no worker, and the reel page is a static read. `apps/worker`
holds only `.env.example`. Every later slice needs a way to get footage into R2 without passing
through the studio's server, a queue that never loses or double-runs a job, a worker that finds
jobs immediately without polling the database expensively, a page that updates live under RLS,
and test doubles for R2 and the AI so specs never touch real services.

## Solution Statement

- **Database**: one new migration `supabase/migrations/<timestamp>_job_queue.sql` (never edit
  #27's). `jobs` and `steps` with owner-only RLS, column-level grants, `claim_job` for
  `service_role` only, and the narrow upload path chosen as a `security definer` function,
  `finish_upload(p_reel_id uuid, p_bytes bigint)`, executable by `authenticated` only. The owner
  gets a column-limited `insert` on `reels` (`id`, `source_name`, `source_key`) under a policy that
  forces `status = 'uploading'`, their own `owner_id`, no `source_bytes`, and a `source_key` that
  ends with that reel's own `reels/<id>/source/original.<ext>` path. Still no `update` or `delete`
  grant on `reels`, so the owner never gets a general right to write `status`.
- **Shared storage package**: the storage interface, its R2 implementation and its fake are
  consumed by two apps (the studio signs uploads and its mock route writes into the fake; the
  worker HEADs and later reads), so per `AGENTS.md` they live in a new package
  `packages/storage` (`@edit-issebya/storage`), TypeScript source only (no build), consumed by
  Next through `transpilePackages` and by Node 24 through type stripping. Each app passes its own
  credentials (studio keys in the studio, worker keys in the worker), so no app ever reads the
  other's keys.
- **Studio**: `createUpload` and `finishUpload` server actions, an `UploadForm` client component
  above `ReelList`, a mock route `/studio/api/e2e-storage-mock/[...key]` (404 unless
  `E2E_MOCK_STORAGE` is exactly `"true"`), and a `LiveReel` client component on the reel page that
  subscribes to `jobs`, `steps` and `reels` changes for that reel and does one catch-up read each
  time the subscription becomes ready (never on a timer).
- **Worker**: a small set of modules with injected dependencies (Supabase client, storage, AI
  runner, clock), so the lease keeper, the `receive` step, the run loop's decision logic, the
  config parser and `doctor` are unit tested without a database; the database behaviour is proven
  by the studio's DB layer and the E2E spec.
- **Tests**: DB integration tests in the existing layer (`apps/studio/db-tests/`), unit tests in
  each workspace, and one E2E spec that uploads the committed clip, spawns the worker's `once` and
  watches the page update without a reload.

## Relevant Files

Use these files to implement the feature:

- `README.md`: root run instructions; gains "Run the worker locally" (run instructions only).
- `AGENTS.md`: repository rules (Yarn only, no em-dashes, packages only for two consumers, turbo
  strict env, docs rules, root-box measurement rule).
- `.adw/project.md`: the ADW profile; Identity, Workspaces, Build, Tests and Protected change (the
  nine `##` headings stay as they are, #27's Protected migration rule stays verbatim).
- `docs/conditional-docs.md`: widen the existing `app_docs/studio.md` line (no new line).
- `app_docs/studio.md`: the studio's feature doc, extended in place; its Rules section has a
  "Do not let a client write to `reels`" rule that this change must rewrite in the same commit
  (the owner now gets a narrow insert).
- `app_docs/checkout.md` ("E2E Stripe mock"): the mock pattern to copy (exact `"true"` flag,
  in-process, routes answer 404 otherwise).
- `apps/web/src/instrumentation.ts` and `apps/web/src/app/api/e2e-stripe-mock/route.ts`: the mock
  flag and 404 route pattern (read only; `apps/web` is not touched).
- `supabase/migrations/20261031105245_studio_skeleton.sql`: `reels`, its grants (`authenticated`
  select only), the `set_updated_at` trigger, the Realtime publication. Read only; never edited.
- `supabase/config.toml`: local stack ports (API 54431, DB 54432); read only.
- `apps/studio/package.json`: scripts and dependencies; gains `@edit-issebya/storage`.
- `apps/studio/next.config.ts`: gains `transpilePackages: ["@edit-issebya/storage"]`.
- `apps/studio/eslint.config.mjs`: gains a guard against the worker's secrets in `src/`.
- `apps/studio/.env.example`: studio variables (`R2_*`, `E2E_MOCK_STORAGE`); comments stay true.
- `apps/studio/playwright.config.ts`: the studio `webServer.env` gains `E2E_MOCK_STORAGE: "true"`.
- `apps/studio/vitest.config.ts`, `apps/studio/vitest.db.config.ts`: unit and DB test configs.
- `apps/studio/src/app/page.tsx`: the `/studio` home; the upload control goes above `ReelList`.
- `apps/studio/src/app/reels/[id]/page.tsx`: the reel page shell; reads jobs and steps and renders
  `LiveReel`.
- `apps/studio/src/app/actions.ts`: login actions; the upload actions go in a new
  `upload-actions.ts` beside it.
- `apps/studio/src/lib/reels.ts`: named columns, statuses, `formatBytes`, `isReelId`.
- `apps/studio/src/lib/supabase-server.ts`, `apps/studio/src/lib/supabase-config.ts`: per-request
  clients and the null config.
- `apps/studio/src/components/ReelList.tsx`, `LoginForm.tsx`: component style to match.
- `apps/studio/test-support/local-supabase.ts`, `apps/studio/test-support/fixtures.ts`: the local
  guard, test users, `insertReel`, `signInLink`, `signedInClient`.
- `apps/studio/scripts/e2e-sign-in-url.ts`: the review sign-in script; gains a sample job and step.
- `apps/studio/db-tests/rls.test.ts`, `apps/studio/db-tests/realtime.test.ts`: extended for
  `jobs`, `steps` and the upload path.
- `apps/studio/e2e/reels.spec.ts`, `login.spec.ts`, `forwarding.spec.ts`: must keep passing with
  the upload form on the page.
- `apps/worker/.env.example`: worker variables; comments stay true.
- `turbo.json`: strict env lists per task.
- `knip.json`: one workspace per package; gains `apps/worker` and `packages/storage`.
- `.gitignore`: gains `.e2e-storage/`.
- `.github/workflows/ci.yml`: no new step; the exported `SUPABASE_URL` and `SUPABASE_SECRET_KEY`
  already reach `test:e2e`, so the spawned `once` gets the CI stack's values.
- `lefthook.yml`: hooks that must stay green.
- `fixtures/footage/short-person.mp4`: never touched or regenerated.
- `node_modules/next/dist/docs/01-app/02-guides/package-bundling.md`,
  `node_modules/next/dist/docs/02-pages/04-api-reference/04-config/01-next-config-js/transpilePackages.md`,
  and the installed route handler and server action guides under `node_modules/next/dist/docs/01-app/`:
  read before the Next.js work.

### New Files

- `supabase/migrations/<timestamp>_job_queue.sql`: `jobs`, `steps`, grants, policies,
  `finish_upload`, `claim_job`, indexes, Realtime publication. Timestamp later than
  `20261031105245` (for example from `date -u +%Y%m%d%H%M%S`).
- `packages/storage/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`,
  `README.md`: the shared storage package (`@edit-issebya/storage`).
- `packages/storage/src/index.ts`: re-exports.
- `packages/storage/src/storage.ts`: the `Storage` interface and `isStorageKey`.
- `packages/storage/src/r2.ts`: `r2Endpoint(accountId, jurisdiction)` and `r2Storage(config)`.
- `packages/storage/src/fake.ts`: `fakeStorage({ root, uploadUrlBase })`, `e2eStorageRoot(cwd)`,
  `isE2EMockStorage(env)`.
- `packages/storage/src/r2.test.ts`, `packages/storage/src/fake.test.ts`: unit tests.
- `apps/studio/src/lib/storage.ts`: `studioStorage(env)`, the studio's per-request storage (fake
  under the flag, R2 with the studio keys, `null` when unconfigured).
- `apps/studio/src/lib/storage.test.ts`.
- `apps/studio/src/lib/upload.ts`: `parseUploadRequest`, `sourceExtension`, `sourceKey`,
  `MAX_UPLOAD_BYTES`.
- `apps/studio/src/lib/upload.test.ts`.
- `apps/studio/src/lib/jobs.ts`: `JOB_COLUMNS`, `STEP_COLUMNS`, `JOB_STATUSES`, `STEP_STATUSES`,
  types, `upsertById`.
- `apps/studio/src/lib/jobs.test.ts`.
- `apps/studio/src/lib/supabase-browser.ts`: `createSupabaseBrowserClient()` (publishable key,
  created lazily inside the component, `null` when unconfigured).
- `apps/studio/src/app/upload-actions.ts`: `createUpload`, `finishUpload`.
- `apps/studio/src/components/UploadForm.tsx`: the upload control.
- `apps/studio/src/components/LiveReel.tsx`: reel status, jobs and step log with the Realtime
  subscription.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`: the storage double's route.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`: 404 without the flag,
  round-trip and key validation with it.
- `apps/studio/db-tests/jobs.test.ts`: the lease tests (Verification 1).
- `apps/studio/test-support/worker.ts`: `runWorkerOnce(env)` (spawns
  `yarn workspace @edit-issebya/worker once` from the repository root, local URL only) and
  `claimableJobIds(admin)`.
- `apps/studio/e2e/upload.spec.ts`: Verification 5.
- `apps/worker/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`,
  `README.md`.
- `apps/worker/src/config.ts` (+ `config.test.ts`): `workerConfig(env)`.
- `apps/worker/src/supabase.ts`: `workerSupabase(config)` (secret key, no session persistence).
- `apps/worker/src/storage.ts`: `workerStorage(env)` (fake under the flag, R2 with the worker
  keys).
- `apps/worker/src/queue.ts`: `claimJob`, `renewLease`, `claimableJobIds`, `finishJob`,
  `failJob`.
- `apps/worker/src/lease.ts` (+ `lease.test.ts`): `keepLease({ renew, everyMs })` returning an
  `AbortSignal` and `stop()`.
- `apps/worker/src/errors.ts` (+ `errors.test.ts`): `errorTail(error)`.
- `apps/worker/src/format.ts` (+ `format.test.ts`): `formatBytes`, `receivedSummary`.
- `apps/worker/src/steps/receive.ts` (+ `receive.test.ts`): the `receive` step.
- `apps/worker/src/run-job.ts` (+ `run-job.test.ts`): runs one claimed job with lease keeping and
  the success and failure writes.
- `apps/worker/src/loop.ts` (+ `loop.test.ts`): `createDrainer` (one job at a time, coalesces
  Realtime and poll signals).
- `apps/worker/src/ai.ts` (+ `ai.test.ts`): `AiRunner` interface, `claudeRunner(path)`,
  `fakeAiRunner(script)`, `aiRunner(env)`, `parseClaudeJson`.
- `apps/worker/src/doctor-checks.ts` (+ `doctor-checks.test.ts`): `runDoctor(deps)`.
- `apps/worker/src/main.ts`, `apps/worker/src/once.ts`, `apps/worker/src/doctor.ts`: entry points.
- `fixtures/footage/short-speech.mp4`: the committed test clip (under 1 MB).
- `scripts/make-test-clip.sh`: how the clip was made (ffmpeg and macOS `say`).

## Implementation Plan

### Phase 1: Foundation

- The migration (tables, grants, policies, functions, publication), applied locally with
  `supabase migration up --local` (on failure: report and stop, never reset).
- `packages/storage` with its interface, R2 implementation, fake and unit tests.
- The test clip and its script.
- Repository wiring: `.gitignore`, `turbo.json`, `knip.json`, the new workspaces installed with
  `yarn install` (lockfile change expected and committed).

### Phase 2: Core Implementation

- Studio: storage factory, upload helpers, server actions, upload form, mock route, live reel page.
- Worker: config, queue calls, lease keeper, `receive`, run loop, `once`, `doctor`, AI runner.

### Phase 3: Integration

- DB integration tests (lease, RLS on new tables and the upload path, Realtime for steps).
- The E2E spec through the landing page's address, spawning the worker's `once`, and the
  negative proof with the subscription temporarily disabled.
- Docs (`app_docs/studio.md`, `docs/conditional-docs.md`, `README.md`, `apps/worker/README.md`,
  `packages/storage/README.md`) and the ADW profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before writing

- Read `app_docs/studio.md`, `app_docs/checkout.md` ("E2E Stripe mock"), the merged #27 code
  listed under Relevant Files, and the installed Next docs on `transpilePackages`, package
  bundling, route handlers (dynamic segments, `PUT`) and server actions.
- Confirm the R2 endpoint form against Cloudflare's R2 docs (S3 API, jurisdictional buckets):
  `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, and
  `https://<R2_ACCOUNT_ID>.<jurisdiction>.r2.cloudflarestorage.com` (for example `.eu.`) when
  `R2_JURISDICTION` is set; region `auto`. Record the doc link for the PR body.

### 2. Migration `supabase/migrations/<timestamp>_job_queue.sql`

- Header comment: what the file adds and that only the worker (secret key) writes job and step
  state; owners write only through the narrow paths below.
- `public.jobs`:
  - `id uuid primary key default gen_random_uuid()`
  - `reel_id uuid not null references public.reels (id) on delete cascade`
  - `owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade`
  - `kind text not null default 'process'` with a **named** constraint
    `constraint jobs_kind_check check (kind in ('process'))` (later migrations drop and re-add it
    with `change` and `render`)
  - `status text not null default 'queued' constraint jobs_status_check check (status in ('queued', 'running', 'done', 'failed'))`
  - `lease_holder text`, `lease_expires_at timestamptz`, `attempts int not null default 0 check (attempts >= 0)`,
    `error_tail text`, `created_at timestamptz not null default now()`, `started_at timestamptz`,
    `finished_at timestamptz`
  - indexes: `jobs_reel_idx (reel_id, created_at)`, and a partial
    `jobs_claimable_idx (created_at, id) where status in ('queued', 'running')`.
- `public.steps`:
  - `id uuid pk default gen_random_uuid()`, `job_id uuid not null references public.jobs (id) on delete cascade`,
    `reel_id uuid not null references public.reels (id) on delete cascade`,
    `owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade`,
    `name text not null`, `status text not null default 'running' constraint steps_status_check check (status in ('running', 'done', 'failed'))`,
    `summary text`, `error_tail text`, `started_at timestamptz not null default now()`,
    `finished_at timestamptz`
  - index `steps_reel_idx (reel_id, started_at)`.
- RLS: `alter table ... enable row level security` on both.
- Grants (defence in depth beside RLS, same style as #27):
  - `revoke all on public.jobs, public.steps from anon;`
  - `revoke all on public.jobs, public.steps from authenticated;` then
    `grant select on public.jobs, public.steps to authenticated;` and
    `grant insert (reel_id, kind) on public.jobs to authenticated;`
  - `reels`: `grant insert (id, source_name, source_key) on public.reels to authenticated;`
    (no update, no delete; `status`, `owner_id` and `source_bytes` come from their defaults).
- Policies (all `to authenticated`, `(select auth.uid())` form as in #27):
  - `"jobs: owner selects own"` and `"steps: owner selects own"`: `using ((select auth.uid()) = owner_id)`.
  - `"jobs: owner inserts a process job for own reel"`: `with check ((select auth.uid()) = owner_id and kind = 'process' and status = 'queued' and exists (select 1 from public.reels r where r.id = reel_id and r.owner_id = (select auth.uid())))`.
  - `"reels: owner inserts own uploading reel"`: `with check ((select auth.uid()) = owner_id and status = 'uploading' and source_bytes is null and (source_key is null or source_key ~ ('^[a-z0-9/_-]*reels/' || id::text || '/source/original\.[a-z0-9]{1,8}$')))`.
    The key must end with the reel's own id, so it can never name another reel's object.
- `public.finish_upload(p_reel_id uuid, p_bytes bigint) returns uuid`, `language plpgsql`,
  `security definer`, `set search_path = ''`:
  - raise (errcode `22023`) unless `p_bytes >= 1`;
  - `update public.reels set status = 'uploaded', source_bytes = p_bytes where id = p_reel_id and owner_id = (select auth.uid()) and status = 'uploading' and source_key is not null`;
    if `not found`, raise (errcode `P0002`, message `no uploading reel of yours with this id`),
    so another owner's reel, a reel in any other state and a call without a user all fail the
    same way;
  - `insert into public.jobs (reel_id, owner_id, kind) values (p_reel_id, (select auth.uid()), 'process') returning id`, return it.
  - `revoke execute on function public.finish_upload(uuid, bigint) from public, anon, service_role;`
    `grant execute ... to authenticated;` (Supabase's default privileges grant execute on new
    `public` functions to `anon`, `authenticated` and `service_role` explicitly, so revoking from
    `public` alone is not enough).
- `public.claim_job(p_worker text, p_lease_seconds int) returns setof public.jobs`,
  `language plpgsql`, `security definer`, `set search_path = ''`:
  - raise unless `p_worker` is non-empty and `p_lease_seconds between 1 and 3600`;
  - one statement: a CTE selecting the oldest claimable id
    (`status = 'queued' or (status = 'running' and lease_expires_at < now())`,
    `order by created_at, id limit 1 for update skip locked`), then
    `update public.jobs j set status = 'running', lease_holder = p_worker, lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = j.attempts + 1, started_at = now() from next where j.id = next.id returning j.*`.
  - `revoke execute ... from public, anon, authenticated; grant execute ... to service_role;`
- Do **not** add an `updated_at` trigger to jobs (no such column); keep `reels`' trigger as is.
- `alter publication supabase_realtime add table public.jobs, public.steps;`
- Run `supabase migration up --local`. If it fails, report the error and stop; never reset.

### 3. Repository wiring and new workspaces

- `.gitignore`: add `.e2e-storage/` with a comment (the storage double's folder, written by the
  studio's mock route and read by the worker under `E2E_MOCK_STORAGE=true`; never commit it).
- `packages/storage/package.json`: `"name": "@edit-issebya/storage"`, `"private": true`,
  `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, scripts `typecheck` (`tsc --noEmit`),
  `lint` (`eslint .`), `lint:fix`, `test` (`vitest run`); no `build`.
- `apps/worker/package.json`: `"name": "@edit-issebya/worker"`, `"private": true`, `"type": "module"`,
  `engines.node` `24.x`, scripts:
  - `worker`: `node --env-file-if-exists=.env.development src/main.ts`
  - `worker:prod`: `node --env-file-if-exists=.env.production src/main.ts`
  - `once`: `node --env-file-if-exists=.env.development src/once.ts`
  - `doctor`: `node --env-file-if-exists=.env.development src/doctor.ts`
  - `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `lint:fix`, `test` (`vitest run`).
  - No `dev`, no `start`, no `build` (the root `yarn dev` and `yarn start` must keep starting only
    the web apps, and Node runs the TypeScript directly). Variables already in the environment
    win over the env file (Node's `--env-file` rule).
- Dependencies, each through the workspace that uses it, from the repository root:
  - `yarn workspace @edit-issebya/storage add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
  - `yarn workspace @edit-issebya/storage add -D typescript@5.9.3 @types/node@^24 vitest@^5.0.3 eslint@^9 typescript-eslint eslint-config-prettier eslint-plugin-security eslint-plugin-no-secrets`
  - `yarn workspace @edit-issebya/worker add @supabase/supabase-js @edit-issebya/storage@workspace:*`
  - `yarn workspace @edit-issebya/worker add -D typescript@5.9.3 @types/node@^24 vitest@^5.0.3 eslint@^9 typescript-eslint eslint-config-prettier eslint-plugin-security eslint-plugin-no-secrets`
  - `yarn workspace @edit-issebya/studio add @edit-issebya/storage@workspace:*`
  - Match the versions the studio already pins where the same package exists.
- `tsconfig.json` for both new workspaces: `target`/`lib` `ES2024`, `module` and
  `moduleResolution` `nodenext`, `strict`, `noUncheckedIndexedAccess`, `noEmit`,
  `allowImportingTsExtensions`, `rewriteRelativeImportExtensions` not needed (no emit),
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `types: ["node"]`, `skipLibCheck`. Relative
  imports use the `.ts` extension (Node's type stripping needs it); no enums, namespaces,
  parameter properties or decorators.
- `eslint.config.mjs` for both: `typescript-eslint` recommended, `eslint-config-prettier`, the
  same `no-secrets` and `security` rules as `apps/studio/eslint.config.mjs`. Where a rule fires on
  deliberate code (`security/detect-child-process` in `ai.ts` and the ffmpeg check,
  `security/detect-non-literal-fs-filename` in the fake), disable it on that line with a reason,
  as `apps/studio/vitest.db.config.ts` does.
- `vitest.config.ts` for both: `include: ["src/**/*.test.ts"]`, database-free.
- `apps/studio/next.config.ts`: add `transpilePackages: ["@edit-issebya/storage"]` with a comment
  (workspace package shipped as TypeScript source).
- `apps/studio/eslint.config.mjs`: in the `src/**` block add `no-restricted-syntax` on
  `MemberExpression[property.name=/^(SUPABASE_SECRET_KEY|R2_WORKER_ACCESS_KEY_ID|R2_WORKER_SECRET_ACCESS_KEY)$/]`
  with the message that the worker's secrets never reach the studio's app code.
- `turbo.json` (strict env mode):
  - `dev` and `start` `passThroughEnv`: add `R2_*` (the studio's server reads its R2 variables at
    run time; `E2E_MOCK_STORAGE` is already covered by `E2E_MOCK_*`).
  - `build` `env`: add `R2_*` and `E2E_MOCK_STORAGE`, so a build that ever reads them rehashes;
    the studio still builds with none set (clients are created per request).
  - `test:e2e` and `@edit-issebya/studio#test:e2e` `passThroughEnv`: add `R2_*`, `WORKER_*`,
    `CLAUDE_CODE_PATH`, `FFMPEG_PATH` (what the spawned worker and the studio's helpers may read;
    the spec forces `E2E_MOCK_STORAGE=true` and `E2E_MOCK_AI=true` itself). `SUPABASE_URL` and
    `SUPABASE_SECRET_KEY` are already listed.
  - `test`: unchanged (database-free, reads no variables).
- `knip.json`: add workspaces
  - `apps/worker`: `entry: ["src/main.ts", "src/once.ts", "src/doctor.ts"]`,
    `project: ["src/**/*.ts"]`, `vitest: true`.
  - `packages/storage`: `entry: ["src/index.ts"]`, `project: ["src/**/*.ts"]`, `vitest: true`.
  - `apps/studio`: unchanged entries; `test-support/worker.ts` is already under `project`.
- Run `yarn install` from the root (the lockfile changes; commit it), then confirm
  `yarn install --immutable` passes.

### 4. `packages/storage`

- `src/storage.ts`:
  - `interface Storage { signUpload(key, { contentType, expiresInSeconds }): Promise<string>; signDownload(key, { expiresInSeconds }): Promise<string>; head(key, options?: { signal?: AbortSignal }): Promise<{ bytes: number } | null>; get(key): Promise<Uint8Array | null>; put(key, body: Uint8Array, options?: { contentType?: string }): Promise<void>; delete(key): Promise<void>; list(prefix): Promise<string[]>; }`
  - `isStorageKey(key)`: `/^[a-z0-9][a-z0-9/._-]{0,511}$/`, no `..` segment, no `//`, no leading
    `/` (a key is never a path out of the fake's root).
- `src/r2.ts`:
  - `r2Endpoint(accountId, jurisdiction?)`: the endpoint form confirmed in task 1; an empty or
    whitespace jurisdiction means none.
  - `r2Storage({ accountId, bucket, jurisdiction, accessKeyId, secretAccessKey })`: one
    `S3Client({ region: "auto", endpoint, credentials, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" })`
    per call of `r2Storage` (callers create it per request or per worker run, never at module
    load). `signUpload` uses `getSignedUrl(new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn })`
    (the checksum setting keeps the SDK from signing a CRC32 header a browser PUT cannot send).
    `head` maps a 404 / `NotFound` to `null`; `get`, `put`, `delete`, `list`
    (`ListObjectsV2`, paginated) are thin wrappers.
- `src/fake.ts`:
  - `isE2EMockStorage(env = process.env)`: `env.E2E_MOCK_STORAGE === "true"` exactly.
  - `e2eStorageRoot(cwd = process.cwd())`: walks up from `cwd` to the first directory holding
    `turbo.json` (the repository or worktree root, where both the studio, run from `apps/studio`,
    and the worker, run from `apps/worker`, meet) and returns `<root>/.e2e-storage`; throws if
    none is found.
  - `fakeStorage({ root, uploadUrlBase })`: every method refuses a key that fails
    `isStorageKey`. `put` writes `<root>/<key>` (creating directories), `get` reads or returns
    `null`, `head` stats (`bytes` from the size) or returns `null`, `delete` removes (no error when
    missing), `list(prefix)` walks the folder and returns sorted keys starting with `prefix`.
    `signUpload` returns `${uploadUrlBase}${key}` (a same-origin path such as
    `/studio/api/e2e-storage-mock/<key>`); `signDownload` returns the same path.
- `src/index.ts`: re-export the above.
- Tests:
  - `fake.test.ts` (temp dir from `fs.mkdtemp(os.tmpdir())`): put, head, get, list and delete
    round-trip; `head`/`get` of a missing key return `null`; `../x`, `/abs`, `a//b` and
    upper-case keys are refused; `isE2EMockStorage` is true only for exactly `"true"` (not
    `"TRUE"`, `"1"`, `" true"`, unset); `e2eStorageRoot` finds a `turbo.json` two levels up and
    throws without one (Verification 4, the round-trip half).
  - `r2.test.ts`: `r2Endpoint("abc")` and `r2Endpoint("abc", "eu")` give the two documented
    forms, `r2Endpoint("abc", " ")` the plain one; `r2Storage(...).signUpload(...)` with dummy
    credentials returns a URL on that host with `X-Amz-Signature` and the key in the path, and no
    `x-amz-checksum` or `x-amz-sdk-checksum-algorithm` parameter (presigning is local, no network).
- `packages/storage/README.md`: first line says what the package is (the storage interface shared
  by the studio and the worker), then links to the root `README.md` and `docs/conditional-docs.md`.

### 5. Test clip

- `scripts/make-test-clip.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`): `say -o` a short
  English sentence to a temporary AIFF, then ffmpeg makes a 720x1280, 30 fps, few-second clip of
  a plain colour background (`-f lavfi -i color=...`, no person on screen) with that speech,
  H.264 (`-pix_fmt yuv420p`, a high CRF), AAC mono at a low bitrate, `-shortest`,
  `-movflags +faststart`, written to `fixtures/footage/short-speech.mp4`. Comment at the top: macOS
  only, run by hand, CI never regenerates it; it never touches `short-person.mp4`.
- Run it once and commit the clip; check it is under 1 MB (`stat -f%z`) and vertical
  (`ffprobe -show_entries stream=width,height`).

### 6. Studio: storage, upload helpers and actions

- `src/lib/storage.ts`: `studioStorage(env = process.env): Storage | null`, read per call (never
  at module load):
  - `isE2EMockStorage(env)` -> `fakeStorage({ root: e2eStorageRoot(), uploadUrlBase: "/studio/api/e2e-storage-mock/" })`;
  - else all of `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_STUDIO_ACCESS_KEY_ID`,
    `R2_STUDIO_SECRET_ACCESS_KEY` set -> `r2Storage(...)` with `R2_JURISDICTION`;
  - else `null`. Also `keyPrefix(env)`: `R2_KEY_PREFIX` trimmed, empty allowed, must match
    `/^([a-z0-9_-]+\/)*$/` or it is treated as unconfigured.
  - It reads only the studio's keys, never the worker's.
- `src/lib/upload.ts`:
  - `MAX_UPLOAD_BYTES = 5 * 1024 ** 3` (R2's single-PUT limit; resumable upload is slice 13).
  - `sourceExtension(name)`: lower-cased extension among `mp4`, `mov`, `m4v`, `webm`, else `null`.
  - `sourceKey(prefix, reelId, ext)`: `${prefix}reels/${reelId}/source/original.${ext}` (must
    satisfy the migration's insert policy pattern and `isStorageKey`).
  - `parseUploadRequest({ name, bytes, type })`: name trimmed, 1 to 200 characters; `bytes` an
    integer from 1 to `MAX_UPLOAD_BYTES`; `type` empty or starting with `video/`; extension
    supported. Returns `{ ok: true, value }` or `{ ok: false, reason }`.
- `src/app/upload-actions.ts` (`"use server"`):
  - `createUpload(input)`: `parseUploadRequest`; `createSupabaseServerClient()` and
    `auth.getUser()` (no user -> `{ status: "signed-out" }`); `studioStorage()` (null ->
    `{ status: "unavailable" }`); `id = crypto.randomUUID()`; insert into `reels`
    `{ id, source_name, source_key }` through the user's client (RLS and the insert policy
    decide; no owner id sent); then `signUpload(key, { contentType, expiresInSeconds: 900 })`.
    Returns `{ status: "ready", reelId, url, contentType }`. Errors logged without the file name.
  - `finishUpload({ reelId, bytes })`: `isReelId`, integer bytes; signed in; `rpc("finish_upload", { p_reel_id, p_bytes })`;
    returns `{ status: "finished", reelId }` or `{ status: "failed" }`. The file body never
    reaches either action.
- Tests: `upload.test.ts` (extensions, key shape against the same regular expression the policy
  uses, size bounds, type and name rules), `storage.test.ts` (flag exactly `"true"` gives the fake,
  R2 variables give an R2 storage whose signed URL is on the R2 host, missing variables give
  `null`, a malformed prefix gives `null`, the worker's key names are ignored).

### 7. Studio: storage double route

- `src/app/api/e2e-storage-mock/[...key]/route.ts`, `export const dynamic = "force-dynamic"`,
  doc comment in the style of `apps/web/src/app/api/e2e-stripe-mock/route.ts`:
  - every method answers 404 (`{ error: "Not found" }`) unless `isE2EMockStorage()`;
  - `PUT`: joins the segments into a key, 400 unless `isStorageKey`, writes
    `new Uint8Array(await request.arrayBuffer())` with the fake's `put`, answers 200 with an
    `ETag` header;
  - `GET`: the bytes or 404; `HEAD`: `Content-Length` or 404.
  - This route is the R2 stand-in; under the flag it receives the body in place of R2. Without the
    flag it never does.
- `route.test.ts`: with `E2E_MOCK_STORAGE` unset (and set to `"1"`), `PUT`, `GET` and `HEAD`
  answer 404 (Verification 4, the 404 half); with it `"true"` and the fake root pointed at a temp
  dir (stub `process.cwd` or inject through a small exported helper), a PUT then GET round-trips
  and a `..` key answers 400.

### 8. Studio: upload control on `/studio`

- `src/components/UploadForm.tsx` (`"use client"`): a labelled file input ("Clip",
  `accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm"`) and an "Upload" button,
  matching `LoginForm`'s classes. On submit: `createUpload` -> `fetch(url, { method: "PUT", body: file, headers: { "Content-Type": contentType } })`
  -> on `ok` `finishUpload` -> `router.push(\`/reels/${reelId}\`)`. A polite live region shows
"Uploading...", "Upload failed. Try again." or "Uploads are not available right now."; the
button is disabled while busy. No `useEffect`; state changes in the event handler.
- `src/app/page.tsx`: render `<UploadForm />` in a `section aria-label="Upload"` between the
  header and `ReelList` (signed-in branch only).
- Layout must hold at 375px and 1920px wide.

### 9. Studio: live status on the reel page

- `src/lib/jobs.ts`: `JOB_COLUMNS = "id, reel_id, kind, status, attempts, error_tail, created_at, started_at, finished_at"`,
  `STEP_COLUMNS = "id, job_id, reel_id, name, status, summary, error_tail, started_at, finished_at"`
  (no lease columns on the page), `JOB_STATUSES`, `STEP_STATUSES`, `JobRow`, `StepRow`,
  `upsertById(rows, row, order)` (replace by id or insert, then sort by `created_at` /
  `started_at`), and `pickColumns(record, columns)` to drop columns a Realtime payload carries
  beyond the list.
- `src/lib/supabase-browser.ts`: `createSupabaseBrowserClient()` with `createBrowserClient` from
  `@supabase/ssr` and `supabaseConfig()`; returns `null` when unconfigured.
- `src/app/reels/[id]/page.tsx`: after reading the reel, read its jobs
  (`.from("jobs").select(JOB_COLUMNS).eq("reel_id", id).order("created_at")`) and steps
  (`.select(STEP_COLUMNS).eq("reel_id", id).order("started_at")`) once, and render
  `<LiveReel reel={reel} jobs={jobs} steps={steps} />` in place of the static `dl`. The step log is
  loaded only here, for the open reel (B3 rule 1).
- `src/components/LiveReel.tsx` (`"use client"`):
  - Keeps `reel`, `jobs`, `steps` in state from the props.
  - One `useEffect` (the external-system subscription, which is the legitimate use): create the
    browser client, `await supabase.realtime.setAuth()`, open one channel
    `reel-<id>-<random>` with three `postgres_changes` listeners: `UPDATE` on `reels`
    (`id=eq.<id>`), `*` on `jobs` (`reel_id=eq.<id>`), `*` on `steps` (`reel_id=eq.<id>`), each
    merged with `upsertById` after `pickColumns`. Listen for the `system` message with
    `extension === "postgres_changes"` and `status === "ok"` (the real ready signal, as
    `apps/studio/db-tests/realtime.test.ts` explains); on it, do one catch-up read of the reel, its
    jobs and its steps (named columns) to cover changes between the server read and the
    subscription, then set `data-realtime="ready"` on the article. Cleanup removes the channel.
    No interval, no timer, no polling (B3 rule 2).
  - Renders the existing fields (`data-testid="reel-status"` stays), then a "Jobs" list (kind and
    `data-testid="job-status"`, attempts, error tail when failed) and a "Steps" list, one
    `data-testid="step-line"` per step (`<name>: <summary>`, or the error tail when failed).
    Empty states: "No job yet." and "No steps yet."
- Tests: `jobs.test.ts` (columns never `*` and carry no lease column; status lists equal the
  migration's check constraints; `upsertById` replaces, inserts and orders; `pickColumns` drops
  extra keys).

### 10. Worker

- `src/config.ts`: `workerConfig(env)` returns `{ supabaseUrl, secretKey, workerId, pollIntervalSeconds, leaseSeconds: 300, renewEveryMs: 60_000, minFreeDiskGb, scratchDir }`
  or throws one message naming every missing variable (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
  `WORKER_ID`). `WORKER_POLL_INTERVAL_SECONDS` defaults to 120 and must be a positive integer;
  `WORKER_MIN_FREE_DISK_GB` defaults to 10; `WORKER_SCRATCH_DIR` defaults to `os.tmpdir()`. Nothing
  is read at module load, so typecheck and import need no variables.
- `src/supabase.ts`: `createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })`.
- `src/storage.ts`: `workerStorage(env)`: fake (`e2eStorageRoot()`, `uploadUrlBase` unused) when
  `isE2EMockStorage(env)`, else `r2Storage` with `R2_WORKER_ACCESS_KEY_ID` /
  `R2_WORKER_SECRET_ACCESS_KEY`, or throws naming the missing variables.
- `src/queue.ts` (each takes the client and config):
  - `claimJob`: `rpc("claim_job", { p_worker, p_lease_seconds })`, first row or `null`.
  - `claimableJobIds`: `.from("jobs").select("id").or(\`status.eq.queued,and(status.eq.running,lease_expires_at.lt.${new Date().toISOString()})\`).limit(1)`;
only `id` is read (B3 rule 3).
  - `renewLease(jobId)`: update `lease_expires_at` to now plus the lease where `id`, `lease_holder = workerId`
    and `status = 'running'`, `.select("id")`; true only when one row came back.
  - `finishJob`, `failJob`: update the job (`done` or `failed`, `finished_at`, `error_tail`) only
    where `lease_holder = workerId` and `status = 'running'`, and the reel (`received` or `failed`).
- `src/lease.ts`: `keepLease({ renew, everyMs })` starts `setInterval`; a renewal that returns
  false or throws aborts the returned `AbortController`'s signal ("lease lost") and stops the
  interval; `stop()` clears it. `lease.test.ts` with fake timers: renews every interval, aborts on
  `false`, aborts on a throw, stops on `stop()`.
- `src/errors.ts`: `errorTail(error, { lines: 20, chars: 2000 })`: the last lines of the message
  and stack. Unit tested.
- `src/format.ts`: `formatBytes` (same 1024 convention and output as the studio's, for example
  `12.3 MB`), `receivedSummary(bytes)` -> `footage received, 12.3 MB`. Unit tested.
- `src/steps/receive.ts`: `receive({ db, storage, job, reel, signal })`: insert a `steps` row
  (`job_id`, `reel_id`, `owner_id` from the job, `name: "receive"`, `status: "running"`), read the
  reel's `source_key` (named columns), `storage.head(key, { signal })`; missing object -> throw
  `source object missing`; else update the step to `done` with `receivedSummary(bytes)` and
  `finished_at`. On a throw, update the step to `failed` with `errorTail` and rethrow. After an
  abort, write nothing more. `receive.test.ts` with a fake storage and a recording db stub: success
  summary, missing object fails the step, abort stops before the step is marked done.
- `src/run-job.ts`: `runJob({ db, storage, config, job })`: `keepLease` around `receive`; success
  -> `finishJob`; failure (not a lost lease) -> `failJob` with `errorTail`; lost lease -> no
  further write (another worker may hold it), log it. Always `stop()` the lease keeper.
  `run-job.test.ts`: success path calls finish, failure path calls fail with a tail, lost lease
  calls neither.
- `src/loop.ts`: `createDrainer({ claim, run })`: `signal()` starts draining (claim, run, repeat
  until `claim` returns `null`) unless already draining, in which case it marks one more pass;
  one job at a time. `loop.test.ts`: two signals while busy give exactly one extra pass; drains
  until empty.
- `src/main.ts`: read config, check free disk (`fs.statfs(scratchDir)`; below the minimum, log and
  skip claiming), subscribe to `INSERT` on `public.jobs` through Realtime (`drainer.signal()`),
  drain once at start, and every `pollIntervalSeconds` call `claimableJobIds` and signal when it
  returns an id. `SIGINT`/`SIGTERM`: stop the timer, remove the channel, wait for the current job,
  exit.
- `src/once.ts`: config, `claimJob` once; none -> print `no job` and exit 0; else `runJob`, exit 0
  when the job ended `done`, 1 otherwise. No subscription, no timer.
- `src/ai.ts`: `interface AiRunner { runJson(prompt: string, schema: object): Promise<unknown> }`;
  `claudeRunner(path)` runs `execFile(path, ["-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema)])`
  (no shell) with a timeout and returns `parseClaudeJson(stdout)`: the `structured_output` field
  when present, else `JSON.parse(result)`; throws when `is_error` is true. `fakeAiRunner(script)`
  returns scripted values. `aiRunner(env)`: the fake (scripted `{ ok: true }`) when
  `E2E_MOCK_AI === "true"` exactly, else `claudeRunner(env.CLAUDE_CODE_PATH || "claude")`.
  `ai.test.ts`: the flag rule and `parseClaudeJson` on sample outputs (structured field, result
  string, error).
- `src/doctor-checks.ts`: `runDoctor(deps)` runs four checks and returns lines
  `ok   supabase reachable`, `ok   r2 bucket reachable`, `ok   ffmpeg ...`, `ok   ai structured call`
  (or `FAIL <name>: <reason>`), plus an exit code. Supabase: `select id from jobs limit 1`. R2:
  `storage.list(prefix)` (or `head` of a key that may be missing; any non-error answer passes).
  ffmpeg: `execFile(FFMPEG_PATH, ["-version"])`, first line. AI:
  `runJson("Reply with ok set to true.", { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] })`
  must return `{ ok: true }`. A missing variable fails its own line, never the whole run.
  `doctor-checks.test.ts`: all fakes pass; each failing dependency fails only its line and sets
  exit code 1.
- `src/doctor.ts`: wires real dependencies (`aiRunner(process.env)`, `workerStorage`), prints the
  lines, exits with the code.
- `apps/worker/README.md`: first line: the worker, which runs on the owner's machine (never on
  Vercel); then links to the root `README.md` and `docs/conditional-docs.md`. No feature
  description.
- Keep `apps/worker/.env.example`'s comments true (they already describe these variables; adjust
  only if a comment became false, for example `E2E_MOCK_STORAGE`'s, which should now say it makes
  storage calls use the `.e2e-storage/` fake).

### 11. DB integration tests (`apps/studio/db-tests/`)

- `test-support/worker.ts`: `claimableJobIds(admin)` (ids of jobs `queued`, or `running` with an
  expired lease) and `runWorkerOnce(env)`: `spawn("yarn", ["workspace", "@edit-issebya/worker", "once"], { cwd: <repository root>, env: { ...process.env, SUPABASE_URL: assertLocalUrl(process.env.SUPABASE_URL), E2E_MOCK_STORAGE: "true", E2E_MOCK_AI: "true", WORKER_ID: \`e2e-${uuid}\`, ...env } })`,
collects output, resolves `{ code, output }` on exit, rejects after 60 s. Child-process lint
  rule disabled on that line with the reason.
- `jobs.test.ts` (Verification 1): `beforeAll` asserts `claimableJobIds(admin)` is empty and fails
  with the leftover ids otherwise (a crashed earlier run or a dev worker is connected); creates a
  user and reel, inserts two queued jobs with backdated `created_at` (older first).
  - `claim_job("a", 300)` returns the older (`running`, `lease_holder` `a`, `attempts` 1,
    `lease_expires_at` about 300 s ahead, `started_at` set);
  - `claim_job("b", 300)` returns the other; a third call returns no rows;
  - set the first job's `lease_expires_at` one minute in the past: `claim_job("b", 300)` returns
    it with `attempts` 2 and `lease_holder` `b`;
  - as `authenticated` (`signedInClient`) and as anon, `rpc("claim_job", ...)` errors (permission
    denied) and changes nothing;
  - `claim_job("", 300)` and `claim_job("a", 0)` error.
  - `afterAll` deletes the user (cascade removes reels, jobs and steps).
- `rls.test.ts` (Verification 2):
  - The "every public table" test also expects `jobs` and `steps` in the list.
  - Rewrite #27's "refuses the owner's insert" test for the new rule: A's insert naming
    `owner_id`, `status` or `source_bytes` is refused; an insert with a `source_key` for another
    reel id is refused; a plain `{ id, source_name, source_key }` insert of their own reel
    succeeds with status `uploading` and owner A.
  - A new `describe("jobs and steps RLS")`: admin inserts a job and a step for A's reel; B selects
    them and gets `[]`; A gets them; B inserting a job for A's reel errors and the count is
    unchanged; A inserting a `process` job for their own reel succeeds; A updating a job's
    `status` and a step's `summary` changes nothing; anon gets nothing.
  - `describe("finish_upload")`: B calling it on A's uploading reel errors and the reel stays
    `uploading` with no job; A calling it succeeds once (reel `uploaded`, `source_bytes` set,
    exactly one `queued` `process` job owned by A) and a second call errors (no second job); A
    calling it on a reel in `received` errors; `p_bytes = 0` errors; anon errors. A's direct
    update of their reel to `received`, `failed` or `uploaded` changes nothing.
- `realtime.test.ts` (Verification 3): generalise `subscribe` to take table, event and filter;
  add a test where A and B both subscribe to `INSERT` on `steps` with `reel_id=eq.<A's reel>`, the
  admin (secret key) inserts a job and a step for A's reel; A receives it within 5 s, B receives
  nothing in the full window after. Keep #27's reels test.

### 12. E2E spec `apps/studio/e2e/upload.spec.ts` (Verification 5)

- `apps/studio/playwright.config.ts`: the studio `webServer.env` becomes
  `{ STUDIO_PORT, E2E_MOCK_STORAGE: "true" }` (an adopted ADW server already has it from the
  profile's dev command).
- Spec, modelled on `reels.spec.ts`:
  - `beforeAll`: create the owner; assert `claimableJobIds(admin)` is empty (fail with the ids
    otherwise, so the worker can only claim this spec's job).
  - Sign in through `signInLink`, open `/studio`, `setInputFiles` on the "Clip" input with
    `fixtures/footage/short-speech.mp4` (resolved from the spec's `import.meta.url`), click
    "Upload".
  - Expect the URL `/studio/reels/<uuid>`; take the id. Through the admin: the reel is `uploaded`
    with `source_bytes` equal to the clip's size, exactly one job, `process`, `queued`; the fake
    holds the object at the reel's `source_key` with the same size (`fakeStorage(...).head`).
  - Wait for `[data-realtime="ready"]`, then
    `page.evaluate(() => { (window as any).__noReload = "marker" })`.
  - `runWorkerOnce()` exits 0 (print its output on failure).
  - Without reloading: `getByTestId("job-status")` has text `done`,
    `getByTestId("step-line")` contains `footage received, ` followed by a size, and
    `getByTestId("reel-status")` has text `received`, each within 10 s.
  - `expect(await page.evaluate(() => (window as any).__noReload)).toBe("marker")`.
  - `afterAll`: delete the owner (cascade) and delete the fake object.
- Extend nothing else: `reels.spec.ts`, `login.spec.ts` and `forwarding.spec.ts` must pass
  unchanged with the upload form on the page.

### 13. Negative proof (Verification 6)

- Temporarily disable the subscription in `LiveReel.tsx` (for example skip the `.subscribe()` call
  but still set `data-realtime="ready"`), run
  `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e -- e2e/upload.spec.ts` and confirm the
  spec fails on `job-status`. Restore the file, confirm `git diff` shows no probe, rerun and
  confirm it passes. State in the PR that this was tried.

### 14. Review sign-in data

- `apps/studio/scripts/e2e-sign-in-url.ts`: when the review user's `received` sample reel has no
  job, insert one `done` `process` job and one `done` `receive` step (`footage received, 12.3 MB`)
  through the admin client, so a reviewer sees the jobs and step log on that reel's page. Reels
  stay inserted by the admin as before.

### 15. Docs

- `app_docs/studio.md` (updated in place): add the issue 43 spec to **Specifications**; widen the
  Overview; new **How it works** subsections "Upload" (two actions, the insert policy,
  `finish_upload`, signed PUT, key layout, the 5 GiB single-PUT cap), "Jobs, steps and the lease"
  (tables, `claim_job`, renewal, lost lease stops work, no retry limit yet), "Live status" (server
  read once, Realtime on `reels`/`jobs`/`steps` for that reel, the catch-up read on each ready
  subscription, no polling), "Storage and AI doubles" (`E2E_MOCK_STORAGE`, `.e2e-storage/`, the
  mock route, `E2E_MOCK_AI`), "Worker" (scripts `worker`, `worker:prod`, `once`, `doctor`, the env
  file rule, poll reads only ids). Update **How to Use**, **Configuration** (studio `R2_*`,
  `E2E_MOCK_STORAGE`; worker variables), **Testing** (the new unit, DB and E2E tests).
- **Rules** (the same commit changes them): replace the "Do not let a client write to `reels`"
  rule with: do not grant `authenticated` update or delete on `reels`, nor insert beyond `id`,
  `source_name`, `source_key` under the uploading-only policy; and add as "never" rules:
  - Never give the owner a general right to write `status`; finishing an upload goes only through
    `finish_upload`.
  - Never let `authenticated` or `anon` execute `claim_job`, or `anon` execute `finish_upload`.
  - Never poll from the studio; the reel page reads on open and on each ready subscription only.
  - Never read more than `id` in the worker's periodic check.
  - Never put large content in rows (files in R2, logs in PostHog).
  - Never store video in Supabase Storage; footage goes from the browser straight to R2.
  - Never use `SUPABASE_SECRET_KEY` or the R2 worker keys in `apps/web` or `apps/studio/src/`.
  - Never turn a double on unless its flag is exactly `"true"`; its route answers 404 otherwise.
  - Never name a worker script `dev` or `start`; never start the worker except through a spec's
    `once` in a run.
  - Never create an R2 or Supabase client at module load.
  - Never stage `.e2e-storage/`; never touch `fixtures/footage/short-person.mp4`.
  - Never point a test at real R2, a real AI or the hosted project.
- `docs/conditional-docs.md`: widen the `app_docs/studio.md` line to also cover the upload, the
  `jobs` and `steps` tables, `claim_job`/`finish_upload`, the live reel page, the worker
  (`apps/worker`), `packages/storage`, the storage and AI doubles and the test clip. No new line.
- `README.md` (root): in the repository layout add `apps/worker/` and `packages/storage/`; add
  "Run the worker locally" (fill `apps/worker/.env.development`, `yarn workspace @edit-issebya/worker doctor`,
  `yarn workspace @edit-issebya/worker worker`, `once` for one job) and note that `yarn dev` does
  not start it. Run instructions only.
- `.adw/project.md` (headings untouched, #27's Protected migration rule verbatim):
  - **Identity**: replace "`apps/worker` holds only its `.env.example` until #43; `packages/` is
    empty" with the worker workspace (`apps/worker`, `@edit-issebya/worker`, Node 24 TypeScript,
    runs on the owner's machine, never on Vercel) and `packages/storage`
    (`@edit-issebya/storage`, shared by the studio and the worker).
  - **Workspaces**: the `web` dev command becomes
    `set -a; . ./.ports.env; set +a; STUDIO_PORT=$BACKEND_PORT E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true E2E_MOCK_STORAGE=true yarn turbo run dev --filter=./apps/web --filter=./apps/studio`;
    add a `worker` row (`apps/worker`, dev command `none (specs spawn once)`, no port variable, no
    default port, no health URL, ADW may start `never`) and a `storage` row (`packages/storage`,
    library, `never`). Extend the mock-flags paragraph with `E2E_MOCK_STORAGE` and the
    `/studio/api/e2e-storage-mock` route; `target_apps` gains `worker` and `storage`.
  - **Build**: `--filter=./apps/worker` and `--filter=./packages/storage`; neither has a build
    script (Node runs the TypeScript; Next transpiles the package), so their build check is
    typecheck; both typecheck with no variables. The studio's `R2_*` and `E2E_MOCK_STORAGE` are
    read at run time, never needed to build.
  - **Tests**: the unit layer gains `apps/worker/src/**/*.test.ts` and
    `packages/storage/src/**/*.test.ts`; the DB layer gains `jobs.test.ts`; the studio E2E suite
    gains `upload.spec.ts`, which spawns the worker's `once`.
  - **Protected**: the add-dependency line gains `@edit-issebya/worker` and `@edit-issebya/storage`;
    add: never stage `.e2e-storage/`; `SUPABASE_SECRET_KEY` and the R2 worker keys never appear in
    `apps/web` or `apps/studio`'s app code (extend the existing secret-key line, which also lets
    `apps/worker` read it); never start the worker (`worker`, `worker:prod`) in a run, only a
    spec's `once`; never touch `fixtures/footage/short-person.mp4`.
  - **Review**: the signed-in `/studio` capture now shows the upload control above the list; the
    reel page of the `received` sample shows the jobs and step log.

### 16. Validation

- Run every command under Validation Commands. Fix what fails without weakening a rule, type or
  test.
- Confirm no em-dash was introduced:
  `grep -rnP "\x{2014}" apps/studio apps/worker packages app_docs/studio.md docs supabase scripts .adw README.md specs/issue-43-*`
  prints nothing.
- Confirm `git status` shows no `.e2e-storage/`, `.env*` (other than the `.env.example` files),
  `next-env.d.ts` or `.ports.env`, and that `fixtures/footage/short-person.mp4` is unchanged.

## Testing Strategy

### Unit Tests

- `packages/storage`: fake round-trip and key refusal, exact flag rule, root discovery, R2
  endpoint forms, presigned PUT shape without checksum parameters.
- `apps/studio/src/lib`: upload parsing and key layout, storage factory selection, job and step
  column lists and status lists, `upsertById`, `pickColumns`.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`: 404 without the flag,
  round-trip and 400 on a bad key with it.
- `apps/worker/src`: config parsing, lease keeper (fake timers), error tail, byte formatting and
  summary, `receive`, `runJob` (finish, fail, lost lease), drainer coalescing, AI runner flag and
  output parsing, doctor lines and exit code.

### Test Coverage

- DB integration (`test:db`), `jobs.test.ts`: catches a `claim_job` that returns the wrong job,
  double-claims under the lease, never re-claims an expired lease, does not count attempts, or is
  callable by `authenticated` (Verification 1). Fails without the migration.
- DB integration, `rls.test.ts` (extended): catches `jobs`/`steps` without RLS or a policy,
  cross-owner reads or inserts, owner writes to job status, and an upload path that lets B finish
  A's upload or A set any status but `uploaded` from `uploading` (Verification 2).
- DB integration, `realtime.test.ts` (extended): catches Realtime delivering A's step to B, with
  the positive control that A receives it (Verification 3).
- Unit, `fake.test.ts` and `route.test.ts`: catch a storage fake that loses or misreports bytes,
  escapes its folder, or a mock route that answers without the exact flag (Verification 4).
- Unit, worker tests: catch a lease that is not renewed or does not stop work when lost, a job
  marked done after a lost lease, the wrong step summary, and doctor failures hiding each other.
- Unit, studio `upload.test.ts`, `storage.test.ts`, `jobs.test.ts`: catch a source key the insert
  policy would refuse, a studio that picks R2 under the flag or the fake without it, and page
  column lists that leak lease columns or use `*`.
- E2E, `apps/studio/e2e/upload.spec.ts`: catches a broken upload (PUT, finish, job insert), a
  worker that does not claim or finish the job, and a reel page that needs a reload to show the
  result (Verification 5); its negative proof (Verification 6) shows it fails without the
  subscription.

### Edge Cases

- Unsupported extension, zero-byte file, a file over 5 GiB, a name over 200 characters.
- PUT fails (network or 4xx): the reel stays `uploading`, no job is created, the form says so.
- `finishUpload` called twice, or for another owner's reel, or for a reel not `uploading`.
- A client insert into `reels` naming `status`, `owner_id`, `source_bytes`, or a `source_key` with
  another reel's id.
- Two workers claiming at once (`skip locked`), an expired lease re-claimed (attempts 2), a lease
  renewal that fails mid-step (the step stops and nothing more is written).
- Source object missing in storage: step and job `failed` with `error_tail`, reel `failed`.
- The worker finishes before the reel page has subscribed: the catch-up read on ready shows the
  final state.
- No studio R2 variables and no flag: the upload says it is unavailable; the studio and worker
  still build and typecheck with no variables.
- `E2E_MOCK_STORAGE` set to anything but exactly `"true"`: the route answers 404.
- Leftover claimable jobs on the shared stack: the DB test and the spec fail at once with the ids
  instead of claiming someone else's job.

## Acceptance Criteria

- The migration applies with `supabase migration up --local`; #27's migration is unchanged.
- `jobs` and `steps` have RLS on and owner-only select policies; no `anon` access; `authenticated`
  cannot update job or step columns or `reels.status`; `claim_job` is executable by
  `service_role` only and `finish_upload` by `authenticated` only.
- Uploading `short-speech.mp4` on `/studio` creates a reel and one `process` job; the studio's
  server never receives the file body outside the storage double.
- `yarn workspace @edit-issebya/worker once` claims the job with a lease, writes the `receive`
  step `footage received, <size>`, marks the job `done` and the reel `received`.
- The reel page shows the job `done` and the step line without a reload, and has no polling.
- The worker has scripts `worker`, `worker:prod`, `once`, `doctor`, `typecheck`, `lint`, `test`,
  and none named `dev` or `start`; `doctor` prints one line per check.
- Doubles are inert unless their flag is exactly `"true"`.
- `fixtures/footage/short-speech.mp4` (under 1 MB, vertical, speech) and
  `scripts/make-test-clip.sh` are committed; `short-person.mp4` is untouched.
- `.e2e-storage/` is gitignored; `turbo.json` and `knip.json` cover the new workspaces; the ADW
  profile is updated with its nine headings unchanged.
- No `SUPABASE_SECRET_KEY` or R2 worker key in `apps/web` or `apps/studio/src/`; no em-dashes.
- Every validation command below passes; `apps/web` and its specs are unchanged.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies the new migration to the shared local stack (the one
  allowed database command; on failure report and stop, never reset).
- `yarn install --immutable`: the committed lockfile matches the new workspaces and dependencies.
- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`:
  ESLint in the three changed workspaces, including the new secret guard.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`:
  `next typegen` and `tsc` for the studio, `tsc` with `erasableSyntaxOnly` for the worker and the
  package.
- `yarn knip`: dead code and unused dependencies across all workspaces.
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`:
  unit tests (storage fake, route, upload helpers, worker modules).
- `yarn turbo run test:db --filter=./apps/studio`: lease, RLS and Realtime integration tests
  against the shared local stack.
- `env -u NEXT_PUBLIC_SUPABASE_URL -u NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY -u NEXT_PUBLIC_SITE_URL -u STUDIO_URL -u STUDIO_PORT -u R2_ACCOUNT_ID -u R2_BUCKET -u R2_JURISDICTION -u R2_STUDIO_ACCESS_KEY_ID -u R2_STUDIO_SECRET_ACCESS_KEY -u R2_KEY_PREFIX -u E2E_MOCK_STORAGE -u SUPABASE_URL -u SUPABASE_SECRET_KEY yarn turbo run build typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage --force`:
  proves the studio builds and the worker and package typecheck with no studio or worker
  variables set.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the
  unfiltered gates, as the hooks and CI run them (the landing page included, unchanged).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: the landing specs unchanged, then
  the studio specs including `upload.spec.ts`, against the run's servers started with the
  profile's updated web dev command (with `E2E_MOCK_STORAGE=true`).

## Notes

- **Narrow path chosen**: the `security definer` function `finish_upload`, not an update policy.
  It keeps `authenticated` without any `update` grant on `reels`, so no policy mistake can ever
  open `status`; the reel move and the job insert happen in one transaction. The issue's wording
  that the owner "may insert a `process` job for their own reel" is kept as a column-limited
  insert policy (tested), although the app itself creates the job only through `finish_upload`.
- **Rule change**: #27's `app_docs/studio.md` rule "no insert grant for `authenticated` on
  `reels`" becomes a narrow, column-limited insert of an `uploading` reel, as the issue requires;
  the doc rule and #27's RLS test change in the same commit.
- **New package**: `packages/storage` because two apps consume the storage interface and the fake
  must map keys to files identically in both processes (AGENTS.md's two-consumer rule). If Node's
  type stripping refused the symlinked workspace package (it should not: Node resolves the
  symlink to `packages/storage/src`, outside `node_modules`), say so in the PR rather than
  duplicating the code silently.
- **New dependencies** (all via `yarn workspace <name> add`): `@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner` (storage); `@supabase/supabase-js` and
  `@edit-issebya/storage` (worker); `@edit-issebya/storage` (studio); dev tooling for the two new
  workspaces (`typescript` 5.9.3, `@types/node`, `vitest`, `eslint`, `typescript-eslint`,
  `eslint-config-prettier`, `eslint-plugin-security`, `eslint-plugin-no-secrets`). `yarn.lock`
  changes in this PR.
- **R2 endpoint**: confirm the plain and jurisdiction forms against Cloudflare's R2 docs and cite
  the page in the PR. `requestChecksumCalculation: "WHEN_REQUIRED"` is needed with current
  `@aws-sdk/client-s3` so a browser PUT to a presigned URL works on R2.
- **Claude Code output**: `parseClaudeJson` prefers `structured_output` (what `--json-schema`
  fills) and falls back to parsing `result`; check against `claude -p --output-format json --json-schema ...`
  on the owner's machine with `doctor` (not in the pipeline).
- **Shared-stack isolation**: `claim_job` takes the oldest claimable job globally, so the lease
  test and the upload spec first assert there is none left over and fail with the ids otherwise;
  all test data is removed through `on delete cascade` from the test user. A dev worker connected
  to the local stack during a run would claim the spec's job (the owner's pre-run step).
- **Rewrite body**: the PUT to the mock route passes through the landing page's rewrite; the clip
  is well under any proxy body limit. In production the PUT goes straight to R2 and never through
  either app.
- **Not in this slice**: a maximum attempts count (a job that keeps crashing is re-claimed after
  each lease expiry), resumable upload (slice 13), measurements and PostHog/OTEL (slice 5, so
  `POSTHOG_*`, `OTEL_*` and `HYPERFRAMES_NO_TELEMETRY` stay unread), video processing (slices 6
  and 7). The pipeline cannot verify real R2 uploads and CORS, the hosted project, or the worker
  as a service on the owner's Mac.
- **Owner steps after merge** (not for the pipeline): `supabase db push` for the hosted project,
  the R2 CORS rule (`PUT` from `https://edit.issebya.com` and `http://localhost:3000`, exposing
  `ETag`), the studio's R2 variables on Vercel, `apps/worker/.env.production`, then `doctor` until
  every line passes.
