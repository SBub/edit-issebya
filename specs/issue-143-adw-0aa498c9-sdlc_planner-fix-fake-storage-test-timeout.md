# Bug: fakeStorage putIfAbsent test times out under the pre-push load

## Metadata

issue_number: `143`
adw_id: `0aa498c9`
issue_json: `{"number":143,"title":"storage: fakeStorage putIfAbsent test in packages/storage/src/fake.test.ts times out under the pre-push load"}`

## Bug Description

`packages/storage/src/fake.test.ts` > `fakeStorage` > `puts bytes only when the key is free, keeping the first content` (line 86) fails the pre-push `yarn test` with `Error: Test timed out in 5000ms.` It passes on its own. Under the pre-push hook turbo runs the web, storage, studio, worker and edit suites at once; in the failing run (adw `0c90e622`, issue #136, a run that changed only a plan markdown file, so the failure is on `develop`) the storage suite took 45.80s, mostly import and transform, and the test hit Vitest's default 5000ms timeout on both push attempts.

Expected: the storage suite passes under the full parallel `yarn test` on the owner's Mac every time. Actual: one of its filesystem tests intermittently exceeds the default 5s budget and fails the push.

## Problem Statement

The storage package's Vitest config uses the default `testTimeout` (5000ms) and `hookTimeout` (10000ms). Its `fakeStorage` tests do real filesystem work in a `mkdtemp` folder (`mkdir`, `writeFile`, `link`, `stat`, `readdir`, `rm`) in the test body and in `beforeEach`/`afterEach`. Those budgets fit an idle machine (whole suite 0.7s alone, 4.2s in a normal parallel run) but not the pre-push hook on a saturated machine, where the same suite took 45.8s.

## Solution Statement

Give `packages/storage/vitest.config.ts` a `testTimeout` and a `hookTimeout` of 20 seconds, with a comment saying why. 20 seconds is the budget the repository already uses for tests slowed by parallel load (`apps/worker/src/step-runner.test.ts`, `apps/worker/src/telemetry.test.ts`, `apps/worker/src/render/render-call.test.ts` and `apps/studio/vitest.db.config.ts`, which sets both `testTimeout` and `hookTimeout` to `20_000`). Set it package-wide in the config, not per test: every test in the file shares the same risk, and so do the `mkdtemp`/`rm` hooks. No assertion, test or source file changes. `fake.ts` needs no change because it has no hang (see Root Cause Analysis).

## Steps to Reproduce

1. On the owner's Mac (8 cores, 16 GB), with other load running (another worktree's run, a browser), push a branch so lefthook runs `yarn test`, or run `yarn turbo run test --force` from the root.
2. turbo runs the five `test` tasks in parallel: the studio suite (38 files), the edit suite (a Node and a Playwright Chromium project), the worker suite (the step runner spawning child processes that each hold 100 to 200 MiB of random, touched memory), web and storage.
3. When the machine is starved of CPU and memory (the failing run: storage `Duration 45.80s`), the storage test at `fake.test.ts:86` reports `Test timed out in 5000ms`. On a less loaded run it passes (measured during planning: storage alone 0.70s, storage in a full forced parallel run 4.23s), which is why it is intermittent.

## Root Cause Analysis

- **No hang in `putIfAbsent`.** `packages/storage/src/fake.ts:286` does `mkdir(dirname(target), { recursive: true })`, `writeFile(temp, body)`, then `linkOnce(temp, target)`, which is one `link(2)` call mapping `EEXIST` to `"exists"`, and finally `rm(temp, { force: true })`. There is no lock, retry loop, polling, sleep or rename that waits on the filesystem; every call is a single bounded syscall. `putFileIfAbsent` (`fake.ts:272`) is the same with `copyFile` in place of `writeFile`. `put`, `head`, `get`, `list` (a recursive `readdir` of a tiny temp tree) and `delete` are equally bounded. So step 1 of the issue finds nothing to fix in `fake.ts`.
- **The time is the machine's, not the test body's.** The test itself makes about ten small filesystem calls. Under the failing run the whole suite took 45.8s against 0.7s alone, about 65 times slower, and Vitest's report put most of it in import and transform. That is a starved machine: five Vitest processes, each with its own worker pool (Vitest defaults to one worker per core per process), plus Chromium for `packages/edit`'s browser project and the worker suite's memory-holding child processes (`apps/worker/src/step-runner.test.ts` deliberately holds incompressible random buffers so macOS cannot compress them), all on 8 cores and 16 GB. Under that pressure macOS swaps, and every `await` on an fs call yields to a scheduler that is not giving the test's worker the CPU back. Any test in the file can be the one that crosses 5s; the `putIfAbsent` one is simply where the stretch landed.
- **The budget is the default.** `packages/storage/vitest.config.ts` sets only `include`, so tests get 5000ms and hooks 10000ms. Other suites in the repository that run under the same parallel hook already raised theirs to 20s for this exact reason; storage never did.
- **Sibling tests (issue step 3).** `round-trips put, head, get, list and delete` and `puts a file only when the key is free, keeping the first content` have the same shape (several bounded fs calls in a temp folder, no waits) and so the same risk, as do the `beforeEach` `mkdtemp` and `afterEach` `rm` hooks. A package-wide config value covers all of them, and `r2.test.ts` and `storage.test.ts` too, without touching each test.

## Relevant Files

Use these files to fix the bug:

- `packages/storage/vitest.config.ts` - the storage package's Vitest config, the one file to change (add `testTimeout` and `hookTimeout` with a comment).
- `packages/storage/src/fake.test.ts` - the failing test (line 86) and its siblings (lines 19 and 64) and the `mkdtemp`/`rm` hooks (lines 10 to 16); read only, no change.
- `packages/storage/src/fake.ts` - `putIfAbsent` (line 286), `putFileIfAbsent` (line 272) and `linkOnce`; read to confirm there is no lock, retry or wait. No change.
- `apps/studio/vitest.db.config.ts` - precedent: `testTimeout: 20_000` and `hookTimeout: 20_000`.
- `apps/worker/src/step-runner.test.ts` - precedent (`{ timeout: 20_000 }`) and the memory-holding spin probes that load the machine during `yarn test`.
- `lefthook.yml` and `turbo.json` - the pre-push `yarn test` and the parallel `test` task that create the load.
- `app_docs/studio.md` - the feature doc `docs/conditional-docs.md` names for changes under `packages/storage`; read its Rules to confirm nothing binds the storage test config. No doc change is needed (a test-config change needs no documentation, per the profile).

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Confirm `fake.ts` has no wait

- Read `packages/storage/src/fake.ts` `putIfAbsent`, `putFileIfAbsent` and `linkOnce` and confirm each is a fixed sequence of single fs calls (no loop, lock, sleep or retry). Change nothing in it.

### 2. Raise the storage package's test and hook timeouts

- In `packages/storage/vitest.config.ts`, inside `test`, add `testTimeout: 20_000` and `hookTimeout: 20_000`, keeping `include` and its comment.
- Above them add a short comment, no em-dashes, saying: the fake's tests do real filesystem work in a `mkdtemp` folder; the pre-push `yarn test` runs every workspace's suite at once, and on a loaded machine this suite has taken 45s against under 1s alone, so the 5s default fails a test that is not hanging; 20s matches the worker's tests and `apps/studio/vitest.db.config.ts`; the hooks get the same budget for `mkdtemp` and `rm`.
- Do not edit any test, any assertion or `fake.ts`. Do not add per-test timeouts.

### 3. Validate

- Run the Validation Commands below, in order.

No browser coverage: the change is confined to `packages/storage`, a library with no browser surface (the profile marks it `never` for ADW start), so no spec and no screenshots.

## Test Coverage

No test needed: this is a pure test-configuration change (a timeout budget in `packages/storage/vitest.config.ts`), no behaviour of `fakeStorage` changes, and a timeout cannot be proven by a deterministic unit test without recreating the machine load. The existing 35 storage tests, run under the full parallel `yarn test`, are the evidence; their assertions stay exactly as they are.

## Validation Commands

Execute every command to validate the bug is fixed with zero regressions.

- `grep -n "Timeout" packages/storage/vitest.config.ts` - before the fix prints nothing (the 5s default applies, the cause of the bug); after it prints `testTimeout: 20_000` and `hookTimeout: 20_000`.
- `yarn turbo run test --filter=...{./packages/storage}` - the storage suite plus its dependents (studio and worker) pass.
- `yarn test` - the full pre-push run, every workspace in parallel; run it three times in a row to show the storage suite passes under the real load.
- `yarn turbo run lint --filter=...{./packages/storage}` - the config file still lints.
- `yarn turbo run typecheck --filter=...{./packages/storage}` - the config still typechecks (the package's build check is typecheck; it has no build script).
- `yarn knip` - no dead code or unused export introduced.
- `yarn format:check` - Prettier is happy with the config and this plan.

## Notes

- No new dependency.
- During planning, one forced full parallel run (`yarn turbo run test --force`) failed elsewhere: `packages/edit/src/build.test.ts` > `build` > `builds the 50-second hand edit in under 200 ms with a ready measurer`, a wall-clock performance assertion also sensitive to parallel load. It is out of scope for this issue and must not be touched here (the owner's rule: fix each flaky test properly in its own change, never re-run to pass). If it fails one of the three `yarn test` runs in step 3, report it as a separate failure on the base rather than weakening it; the storage suite's own result is what this fix is judged on.
- If the storage suite ever needs more than 20s again, the cause is the hook's total parallel load (five Vitest pools plus Chromium plus the step runner's memory probes on one machine), which is a wider question (for example capping turbo's `--concurrency` or Vitest's `maxWorkers` in the hook) and not this bug's minimal fix.
