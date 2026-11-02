# Bug: the worker never creates its scratch folder, and doctor cannot see it or a read-only R2 key

## Metadata

issue_number: `91`
adw_id: `fb57dacf`
issue_json: `{"number":91,"title":"fix: the worker creates its scratch folder at start-up, and doctor proves R2 write access"}`

## Bug Description

On a machine where the worker's scratch folder (`WORKER_SCRATCH_DIR`, default the OS temp folder)
does not exist yet, `yarn workspace @edit-issebya/worker worker:prod` starts but never claims a
job. Every heartbeat and every drain fails with
`ENOENT: no such file or directory, statfs '<scratch dir>'` from `statfsFreeBytes`
(`apps/worker/src/disk-guard.ts:14`), called by the heartbeat (`main.ts`) and by `guardedClaim`
(`disk-guard.ts`, from `loop.ts`). The worker loops on that error forever. `once` has the same
problem (its `guardedClaim` fails the same way).

`doctor` passes all seven checks in that state, so it does not catch the missing folder. It also
prints `ok   r2 bucket reachable` with a read-only R2 key, because its `r2` check only lists; the
first real job then fails in `convert` with `Error: Access Denied`.

Expected: the worker (`worker`, `worker:prod`, `once`) creates its scratch folder at start-up
(`mkdir -p`), and exits with one clear line naming the path and the reason when it cannot.
`doctor` reports the scratch folder (exists, or can be created, without creating it) and proves
R2 write access with a put, get and delete of a probe object, naming which of the three failed.

## Problem Statement

1. Nothing creates `config.scratchDir` before the first `statfs`: `sweepStaleScratch` tolerates a
   missing folder, and `withJobScratch` creates only `<scratchDir>/<job id>`, which is never
   reached because the guard fails first.
2. A folder that cannot be created gives an endless loop of `statfs` errors instead of a clear
   exit.
3. `doctor` has no scratch folder check, and its `r2` check proves listing only, not writing.

## Solution Statement

- `apps/worker/src/config.ts`: extract the scratch folder resolution into an exported
  `scratchDirOf(env)` (`env.WORKER_SCRATCH_DIR?.trim() || tmpdir()`), used by `workerConfig`, so
  `doctor` resolves the same path without needing the Supabase variables.
- `apps/worker/src/scratch.ts`: add
  - `prepareScratchDir(dir, { error, exit })`: `mkdir(dir, { recursive: true })`; on failure
    calls `error("worker: scratch folder <dir> cannot be created: <reason>")` (one line, the
    error's message first line, e.g. `EEXIST: file already exists, mkdir '<dir>'` or
    `ENOTDIR ...`) and `exit(1)`. Defaults `console.error` and `process.exit`. Also treat "it
    exists but is not a folder" as a failure (`mkdir` recursive on an existing regular file
    throws `EEXIST`, so this comes for free; keep a `stat` check only if a test shows it does not).
  - `scratchDirState(dir)`: never creates anything. `stat(dir)`: a folder gives `"exists"` (and
    `access(dir, W_OK)` must pass, else throw `<dir> is not writable`); something else throws
    `<dir> is not a folder`; `ENOENT` walks up to the nearest existing ancestor, which must be a
    writable folder (else throw `<dir> cannot be created: <ancestor> is not a writable folder`),
    and gives `"can be created"`.
- `apps/worker/src/main.ts`: `await prepareScratchDir(config.scratchDir)` right after
  `workerConfig()` and before `sweepStaleScratch`, the heartbeat and the first claim.
- `apps/worker/src/once.ts`: the same call before `guardedClaim`.
- `apps/worker/src/doctor-checks.ts`:
  - `DoctorDeps.r2` becomes `() => { storage: Pick<Storage, "list" | "put" | "get" | "delete">;
prefix: string }` (built inside the check so a missing variable still fails that line only).
    The check lists `prefix`, then puts a few bytes under
    `<prefix>doctor/probe-<random hex>.txt`, gets it back and compares the bytes, then deletes it.
    Each stage wraps its error: `put <key>: <reason>`, `get <key>: <reason>` (also when it reads
    `null` or different bytes), `delete <key>: <reason>`. Line name changes to
    `r2 bucket readable and writable` (`ok   r2 bucket readable and writable`). If get fails,
    still attempt the delete (best effort, `finally`), so a half-run probe is not left behind.
  - `DoctorDeps.scratchDir: () => Promise<{ dir: string; state: "exists" | "can be created" }>`;
    eighth line, appended last so the other lines keep their indexes:
    `ok   scratch dir <dir> exists` / `ok   scratch dir <dir> can be created`, or
    `FAIL scratch dir: <reason naming the path>`.
- `apps/worker/src/doctor.ts`: wire `r2: () => ({ storage: workerStorage(), prefix:
keyPrefix(process.env) ?? "" })` (or keep the existing `R2_KEY_PREFIX?.trim()` read, whichever
  `keyPrefix` validation makes cleaner; a malformed prefix should fail the line), and
  `scratchDir: async () => { const dir = scratchDirOf(process.env); return { dir, state: await
scratchDirState(dir) }; }`. Update the header comment (eight checks, R2 write).
- Docs: `app_docs/storage.md` "Scratch cleanup" and `app_docs/studio.md` "Worker" state that the
  worker creates its scratch folder at start-up and exits naming the path when it cannot, and the
  doctor's scratch and R2 write checks.

No change to the disk guard's thresholds, `guardedClaim`, `statfsFreeBytes` or the slimming.

## Steps to Reproduce

1. Point the worker at a missing folder, e.g. `WORKER_SCRATCH_DIR=/tmp/issue-91-missing/prod`
   (with `/tmp/issue-91-missing` absent).
2. Without starting the worker (Protected: never start `worker` / `worker:prod` in a run), the
   failure reproduces as a unit: `statfsFreeBytes("/tmp/issue-91-missing/prod")` rejects with
   `ENOENT ... statfs`, which is what both the heartbeat and `guardedClaim` call first.
3. `doctor` with that variable prints no scratch line, and with an R2 double whose `put` rejects
   `Access Denied` it still prints `ok   r2 bucket reachable` (the current `r2` dependency only
   lists).

## Root Cause Analysis

The scratch folder is assumed to exist. `config.ts` resolves it, but no code path creates it:
`sweepStaleScratch` returns quietly on `ENOENT`, `withJobScratch` only `mkdir`s the per-job child,
and the disk guard's `statfs` runs on the parent before any job folder exists. On the developer's
machine the development folder existed from earlier runs, which hid the gap. The doctor was
written as a reachability check: it never looked at the scratch folder and its R2 check used only
`list`, which a read-only key permits.

## Relevant Files

Use these files to fix the bug:

- `README.md` - mentions `doctor`; no change expected beyond what the docs need.
- `AGENTS.md` - repository rules (no em-dashes, commits, hooks).
- `.adw/project.md` - profile; worker is never started, only unit tests and `once` from specs.
- `docs/conditional-docs.md` - points to `app_docs/studio.md` (`apps/worker`) and
  `app_docs/storage.md` (scratch cleanup, the disk guard).
- `app_docs/studio.md` - "Worker" section describes the scripts and `doctor`; update it.
- `app_docs/storage.md` - "Scratch cleanup", "Disk guard", "Configuration", "Testing"; update it.
- `apps/worker/src/main.ts` - long-running entry; must create the folder before the first beat
  and claim.
- `apps/worker/src/once.ts` - single-job entry (spawned by specs); same.
- `apps/worker/src/config.ts` - resolves `scratchDir`; extract `scratchDirOf`.
- `apps/worker/src/config.test.ts` - extend for `scratchDirOf` only if not covered already by
  `workerConfig` tests.
- `apps/worker/src/scratch.ts` - add `prepareScratchDir` and `scratchDirState`.
- `apps/worker/src/scratch.test.ts` - tests for both.
- `apps/worker/src/disk-guard.ts` - `statfsFreeBytes`, the call that fails; read only, no change.
- `apps/worker/src/doctor-checks.ts` - the doctor's checks; new `scratch dir` line, R2 write probe.
- `apps/worker/src/doctor-checks.test.ts` - update `PASSING` and the expected lines, add the new
  cases.
- `apps/worker/src/doctor.ts` - wires the real dependencies.
- `apps/worker/src/storage.ts` - `workerStorage()`, the R2 or fake storage the doctor probes.
- `packages/storage/src/storage.ts` - the `Storage` interface (`list`, `put`, `get`, `delete`)
  and `isStorageKey` (the probe key must satisfy `^[a-z0-9][a-z0-9/._-]*$`).
- `packages/storage/src/fake.ts` - `fakeStorage`, the folder double used in the doctor tests.
- `apps/worker/README.md` - check for a doctor or scratch description to keep in step.

### New Files

None.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Resolve the scratch folder in one place

- In `apps/worker/src/config.ts` export `scratchDirOf(env: Env = process.env): string`
  returning `env.WORKER_SCRATCH_DIR?.trim() || tmpdir()`, and use it in `workerConfig`.

### 2. Create and inspect the scratch folder (`apps/worker/src/scratch.ts`)

- Add `prepareScratchDir(dir, { error = console.error, exit = process.exit } = {})`: recursive
  `mkdir`; on any error, one line `worker: scratch folder <dir> cannot be created: <first line of
the error message>` through `error`, then `exit(1)`. Typed so `exit` returning (in tests) does
  not fall through into later code: return after calling it.
- Add `scratchDirState(dir): Promise<"exists" | "can be created">` as in the Solution Statement,
  creating nothing (`stat`, `access` with `constants.W_OK`, walking `dirname` up to the root).
- Keep the existing `eslint-disable-next-line security/detect-non-literal-fs-filename` comment
  style on each fs call.

### 3. Call it at start-up

- `apps/worker/src/main.ts`: `await prepareScratchDir(config.scratchDir);` after
  `const config = workerConfig();` and before the storage/telemetry set-up is used, and in any
  case before `sweepStaleScratch`, `startHeartbeat` and `drainer.signal()`. Update the header
  comment with one sentence: it creates the scratch folder first and exits when it cannot.
- `apps/worker/src/once.ts`: the same call before `guardedClaim`.

### 4. Doctor: the scratch dir check and the R2 write probe

- `apps/worker/src/doctor-checks.ts`: change `DoctorDeps.r2` and add `DoctorDeps.scratchDir` as
  in the Solution Statement. The `r2` line is `r2 bucket readable and writable`; it lists, puts
  `<prefix>doctor/probe-<12 random hex chars>.txt` (a short ASCII body), gets and compares, and
  deletes in a `finally` once the put succeeded. Errors name the stage and key:
  `put <key>: <reason>`, `get <key>: <reason>` / `get <key>: probe missing` /
  `get <key>: probe differs`, `delete <key>: <reason>`. If the stage itself passed but the
  `finally` delete fails, the line fails naming the delete.
- Append the `scratch dir` check last: `ok   scratch dir <dir> exists`,
  `ok   scratch dir <dir> can be created`, or `FAIL scratch dir: <reason>`.
- `apps/worker/src/doctor.ts`: wire both, using `workerStorage()`, the key prefix and
  `scratchDirOf(process.env)` / `scratchDirState`. Update the header comment.

### 5. Unit tests

- `apps/worker/src/scratch.test.ts`:
  - `prepareScratchDir` on a missing nested path under the test's temp folder creates it, and
    `statfsFreeBytes(path)` (imported from `./disk-guard.ts`) then resolves to a positive number;
    `exit` is not called. Before the fix `statfsFreeBytes` on that path rejects with `ENOENT`.
  - With a regular file at the path (and, separately, a regular file as a parent segment),
    `prepareScratchDir` calls `exit(1)` once and `error` once with a message containing the path
    and `cannot be created`.
  - `scratchDirState`: an existing folder gives `"exists"`; a missing nested path under a writable
    folder gives `"can be created"` and the path is still missing afterwards; a regular file at the
    path, or as a parent, rejects with a message containing the path.
- `apps/worker/src/doctor-checks.test.ts`:
  - `PASSING.r2` returns a `fakeStorage({ root: <mkdtemp folder>, uploadUrlBase: "" })` with a
    prefix such as `dev/`; `PASSING.scratchDir` returns `{ dir: "/scratch", state: "exists" }`.
    Clean the temp folder in `afterEach`.
  - "passes every line" expects eight lines, the r2 line `ok   r2 bucket readable and writable`
    and the last `ok   scratch dir /scratch exists`; afterwards `storage.list("dev/")` (or a
    `readdir` of the root) shows no probe object under `dev/doctor/`.
  - A write-refusing double (the fake with `put` replaced by a rejection `Access Denied`) gives
    `FAIL r2 bucket readable and writable: put dev/doctor/probe-<hex>.txt: Access Denied`
    (match with a regex on the hex) and exit code 1.
  - A double whose `get` returns `null` fails naming `get`; one whose `delete` rejects fails
    naming `delete`.
  - The scratch line: `state: "can be created"` prints `ok   scratch dir <dir> can be created`;
    a rejecting `scratchDir` prints `FAIL scratch dir: <message>`.
  - "fails only the line of the failing dependency" gets a case for `scratchDir` at index 7; the
    existing `r2` case (a throwing factory) stays at index 1.

### 6. Documentation

- `app_docs/storage.md`, "Scratch cleanup": a bullet that `prepareScratchDir` creates
  `WORKER_SCRATCH_DIR` (with its parents) at `worker`, `worker:prod` and `once` start-up, before
  the first heartbeat or claim, and exits 1 with
  `worker: scratch folder <dir> cannot be created: <reason>` when it cannot. "Configuration":
  `WORKER_SCRATCH_DIR` is created when missing. "Testing": mention the new `scratch.test.ts` and
  `doctor-checks.test.ts` cases. Add a Rules line: never read the scratch volume before creating
  the scratch folder.
- `app_docs/studio.md`, "Worker": `doctor` also checks the scratch folder (exists or can be
  created, never creating it) and proves R2 write access with a probe under
  `<R2_KEY_PREFIX>doctor/` it puts, reads back and deletes. Mention that the worker scripts create
  the scratch folder at start-up.
- `apps/worker/README.md`: keep any doctor description in step (only if it lists the checks).
- No em-dashes anywhere.

### 7. Run the validation commands

- Run every command in `Validation Commands` and fix anything that fails.

## Test Coverage

Unit layer (Vitest, `apps/worker/src/**/*.test.ts`, run by `yarn turbo run test
--filter=./apps/worker`):

- `scratch.test.ts`: start-up on a missing path creates it so the first `statfsFreeBytes`
  succeeds (fails today: nothing creates it and `statfs` rejects `ENOENT`); an uncreatable path
  exits 1 with the path in the message; `scratchDirState` reports without creating.
- `doctor-checks.test.ts`: a write-refusing storage double fails the r2 line naming the put
  (passes today because the check only lists), a working one passes and leaves no probe object,
  and the eighth `scratch dir` line prints for both states and for a failure.

No E2E spec: the worker has no browser surface (the profile marks it "never" started by ADW), and
the user-visible symptom is a worker log, not a studio page. The existing E2E specs still spawn
`once`, which now creates its (already existing) scratch folder first, so they also cover that the
new start-up step does not break a normal run. No screenshots for review.

## Validation Commands

Execute every command to validate the bug is fixed with zero regressions.

- `yarn workspace @edit-issebya/worker test src/scratch.test.ts src/doctor-checks.test.ts` -
  the new regression tests (run once before the fix to see them fail, after to see them pass).
- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker` - ESLint, including the security plugin's fs rule.
- `yarn turbo run typecheck --filter=./apps/worker` - the worker's build check (it has no build
  script), covers the `DoctorDeps` shape change.
- `yarn knip` - no unused export (`scratchDirOf`, `prepareScratchDir`, `scratchDirState` must all
  be used).
- `yarn turbo run test --filter=./apps/worker` - the worker's whole unit suite.
- `yarn turbo run build --filter=./apps/worker` - the profile's build command for the worker.
- `yarn test:e2e` (as `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`) - run by the
  test phase; the studio specs spawn `once`, so they prove the start-up change keeps jobs running.

## Notes

- Never start `worker` or `worker:prod` to reproduce (Protected); the unit tests cover the
  start-up function directly, and `once` is exercised by the E2E specs.
- No new dependency.
- The R2 probe key must pass `isStorageKey` (lower-case `[a-z0-9/._-]`, no `//`), so use lower-case
  hex for the random part and a validated prefix.
- The `r2` line's name changes, which is user-visible in `doctor` output; the docs say so.
- No change to the disk guard's thresholds, `guardedClaim`, `statfsFreeBytes` or the slimming.
- Commits: Conventional Commits, no trailers, no AI attribution. No em-dashes.
