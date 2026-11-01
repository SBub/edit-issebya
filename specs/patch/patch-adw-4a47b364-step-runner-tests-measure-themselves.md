# Patch: step-runner tests measure CPU and memory against what each child measured itself

## Metadata

adw_id: `4a47b364`
review_change_request: `SBub/edit-issebya#61: the step-runner tests' fixed memory and wall-clock CPU bounds fail on Linux CI`

## Issue Summary

**Original Spec:** `specs/issue-29-adw-4a47b364-sdlc_planner-pipeline-convert-transcribe-retime.md`
**Issue:** `apps/worker/src/step-runner.test.ts` spins on `Date.now()`, so under CI scheduling a 600 ms wall spin can burn under 500 ms of CPU and `cpu_ms >= 500` / `>= 1000` fails. Its memory bounds are fixed absolute numbers (`peak_rss_bytes < 250 * MB` in "keeps the larger peak", `< 200 * MB` in "the largest single process without it"), which leave a guessed allowance for one Node process's own resident memory and differ between macOS and Linux Docker. Nothing tests the max-not-sum arithmetic deterministically.
**Solution:** Test file only (`step-runner.ts` is not changed). (1) One spin helper that loops until `process.cpuUsage()` (user + system) reaches the CPU target **and** a wall-clock floor is reached, so both CPU and wall lower bounds hold under any scheduling (chosen option: keep a wall floor in the same loop, bounds unchanged). (2) Each real child prints its own `process.resourceUsage().maxRSS * 1024` as its last stdout line; the memory assertions compare against those self-reports (max plus `16 * MB`, and strictly below the sum), and every fixed absolute upper bound is removed. (3) A deterministic `runToolsStep` test through the `spawnTool` seam with fixed `/usr/bin/time` reports for `process.platform`, asserting exact sums and maxima and the code-127 exclusion.

## Files to Modify

- `apps/worker/src/step-runner.test.ts`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Replace the wall-clock spins with one CPU-and-wall spin helper

- Add a top-level helper next to `node()`:
  ```ts
  // Burns at least `ms` of CPU (user + sys) and lasts at least `ms` of wall time,
  // holding `mb` MiB, then prints its own peak RSS in bytes as the last stdout line.
  function spin(mb: number, ms: number): string {
    return `const b = Buffer.alloc(${mb} * 1024 * 1024, 1); const t = Date.now();
      for (;;) { const c = process.cpuUsage(); if (c.user + c.system >= ${ms} * 1000 && Date.now() - t >= ${ms}) break; }
      void b; console.log(process.resourceUsage().maxRSS * 1024);`;
  }
  ```
  `process.cpuUsage()` with no argument is CPU since the child started; `maxRSS` is KiB on both platforms, so `* 1024` is the report's unit.
- `runStep` "measures CPU and peak memory" (line 39): use `node(spin(200, 1100))`. Keep `peak_rss_bytes >= 200 * MB`, `cpu_ms >= 500`, `wall_ms >= 1000`.
- Delete the `busy` helper in `describe("runToolsStep")` (lines 170-171) and use `spin(10, 600)` at lines 202 and 225 (bounds `cpu_ms >= 500`, `wall_ms >= 600` unchanged).
- Keep `does not count waiting as CPU` exactly as it is.

### Step 2: "Sums CPU over the calls and keeps the larger peak" against the children's self-reports

- Calls become `tool({ file: NODE, args: ["-e", `console.log("a"); ${spin(50, 600)}`] })` and the same with `"b"` and `spin(200, 600)`.
- Replace `expect(stdouts).toEqual(["a\n", "b\n"])` with a parse: split each stdout on `\n`, drop the trailing empty string, assert the first line is `"a"` / `"b"`, and read `selfA` / `selfB` as `Number(lastLine)`.
- Keep `cpu_ms >= 1000` (comment: each call burns at least 600 ms of CPU by construction), `wall_ms >= 1200`, and the summary match.
- Replace lines 190-191 with:
  - `expect(peak).toBeGreaterThanOrEqual(200 * MB)` (sanity floor),
  - `expect(peak).toBeGreaterThanOrEqual(Math.max(selfA, selfB))`,
  - `expect(peak - Math.max(selfA, selfB)).toBeLessThan(16 * MB)` with a comment: the report is taken at exit and reads 0 to 2.3 MiB above the child's own `maxRSS` (macOS 0 to 1.7, Linux Docker 1.8 to 2.3); 16 MiB is about 7 times that and well below the smaller call's own resident memory (at least 46 MiB), so a sum cannot pass,
  - `expect(peak, "peak memory summed over the calls").toBeLessThan(selfA + selfB)`, separately.

### Step 3: "The largest single process without it" against the grandchildren's self-reports

- In `describe("a tool with three grandchildren ...")`: each grandchild prints `process.resourceUsage().maxRSS * 1024` to stdout when its 4 s timer fires (`setTimeout(() => { void b; console.log(process.resourceUsage().maxRSS * 1024); }, 4000)`).
- The parent spawns them with `stdio: ["ignore", "pipe", "ignore"]`, collects each child's stdout, and when `left === 0` writes `JSON.stringify(Math.max(...grandchildren, process.resourceUsage().maxRSS * 1024))` to a file in the test's temp `dir` (pass the path through `JSON.stringify` into the script, as the abort test does with `pidFile`; the max includes the parent because `/usr/bin/time` reports the largest of every reaped process). Use one file per test (`join(dir, "tree-sampled.json")`, `join(dir, "tree-single.json")`), read it after `runStep` with the same `eslint-disable-next-line security/detect-non-literal-fs-filename` comment.
- "stores the whole tree's peak with group sampling": keep `>= 300 * MB` unchanged.
- "stores the largest single process without it": replace `< 200 * MB` with `>= 100 * MB` (sanity floor), `>= largest` and `peak - largest < 16 * MB`. No fixed absolute upper bound remains in the file.

### Step 4: Deterministic arithmetic test through `spawnTool`

- Import `type ChildRun` and `type SpawnTool` from `./step-runner.ts`.
- Add a helper that builds the report text for `process.platform` in the formats `time-report.ts` parses, with exact values (seconds as two-decimal strings, RSS a multiple of 1024 so the GNU KiB form is exact):
  - darwin: `        1.00 real         ${user} user         ${sys} sys\n${bytes}  maximum resident set size\n`
  - otherwise (linux): `\tUser time (seconds): ${user}\n\tSystem time (seconds): ${sys}\n\tMaximum resident set size (kbytes): ${bytes / 1024}\n`
- A fake `SpawnTool` that returns queued `ChildRun`s (`exitSignal: null`, `output`/`stdout` `"ok\n"` for code 0, `"not found\n"` for 127).
- Test "sums CPU exactly and keeps the max of every report and group peak, skipping a tool that never started": calls
  - A: code 0, user 0.40 sys 0.12 (520 ms), RSS 300 MiB, `groupPeakBytes: 200 * MB`,
  - B: code 0, user 1.00 sys 0.25 (1250 ms), RSS 100 MiB, `groupPeakBytes: 450 * MB`,
  - C: code 127, user 9.00 sys 0.99, RSS 900 MiB, `groupPeakBytes: 999 * MB`; `work` catches its rejection (`/two exited with 127/`) and returns `{ what: "done" }`.
    Assert `cpu_ms === 1770` and `peak_rss_bytes === 450 * MB` on the done call (the sum of peaks would be 600 MiB or more).
- Test "a tool that never started leaves CPU and memory null": only call is C (code 127); `runToolsStep` rejects with `/exited with 127/`; the failed call has `cpu_ms: null, peak_rss_bytes: null`.
- No real process and no timing assertions in these two tests.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn turbo run lint --filter=./apps/worker`
2. `yarn turbo run typecheck --filter=./apps/worker`
3. `yarn knip` and `yarn format:check`
4. `yarn turbo run test --filter=./apps/worker` (run it three times in a row; every run passes, `step-runner.test.ts` included)
5. `yarn workspace @edit-issebya/worker test:tools`

## Patch Scope

**Lines of code to change:** about 120 in `apps/worker/src/step-runner.test.ts`
**Risk level:** low
**Testing required:** worker unit suite (real `/usr/bin/time` on macOS locally, GNU on Linux CI), lint, typecheck, knip, format check, and the worker's tool tests.
