# Patch: Make "a reload resumes" deterministic without weakening its resume gate

## Metadata

adw_id: `67f9b648`
review_change_request: `Issue #2: The new E2E spec 'a reload resumes' (apps/studio/e2e/multipart-upload.spec.ts:221) is flaky. In the spec's full validation run, PORT=9211 STUDIO_PORT=9111 yarn test:e2e, it failed at line 245, expect(counts.parts[4]).toBe(1), with 'Expected: 1, Received: 2'. Run alone with --grep "a reload resumes" it passed 3 of 3 times, and in my live browser resume part 4 was sent once. Uppy 6.3.0 sends parts one at a time (S3Uploader #uploadRemainingParts awaits each part), so part 4 cannot go out before the reload. A second part-4 PUT after the reload means part 4 failed once and was retried. That fits the retry design, but nothing in the run explains why it failed. The assertions that guard the resume (parts 1 and 2 sent once, which is the line the negative probe fires on) held. The extra assertion is stricter than the spec, which asks only that 'parts 3 and 4 complete'. Even so, a new spec that fails intermittently makes the spec's E2E validation command, and CI, fail at random. Resolution: On this branch, make the spec deterministic without weakening its resume gate. First, find out why part 4 is re-sent in the full run: log Uppy's upload-error and the mock route's answer for part 4, for example from a leftover held request or the dev server compiling under load. Fix that cause if it is in the code. If the retry is legitimate, align the assertion with the spec's wording: keep counts.parts[1] and counts.parts[2] equal to 1, assert part 4 completed (toBeGreaterThanOrEqual(1), or count only finished 200 responses via requestfinished), and keep the object hash, the one-reel, one-job and event-once checks. Then run the full PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e several times in a row and confirm it is stable. Do not re-run to get a green result. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md` (task 16, test "a reload resumes": "parts 1 and 2 sent once, at least one list request, parts 3 and 4 complete")
**Issue:** `apps/studio/e2e/multipart-upload.spec.ts:245` asserts `expect(counts.parts[4]).toBe(1)`, where `counts.parts` counts every part PUT the browser _sends_ (`page.on("request")`). In the full suite part 4 was sent twice. The likely mechanism, found in the installed Uppy: `S3mini.uploadPart` goes through `S3Client.xhr`, which calls `fetcher` (`node_modules/@uppy/core/lib/utils/fetcher.js`) with `retries: 3`. `fetcher` silently re-sends the same request after 300 ms when the XHR ends with status 0 (connection dropped) or a 5xx, and only rejects after the last try. So a single transport hiccup on part 4 (the dev server or the landing page's `/studio` rewrite proxy answering 5xx or dropping the connection under full-suite load) produces a second PUT **without** any `upload-error` event, which is why nothing in the run explained it. This is not yet confirmed: the actual status of the first part-4 answer is unknown.
**Solution:** First, capture the evidence: temporarily log every part PUT's response status, every `requestfailed` with its error text, and the browser console, then run the full suite until the double send reproduces. If the first answer is a 4xx, or a 5xx thrown by our own code (the mock route rethrows any non-`MultipartError` as a 500, `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts:82-91`), fix that cause in the code. If it is a transport failure (status 0, or a 5xx from Next's dev server or proxy rather than from our handler), the retry is legitimate. Then count parts that _completed_ (a `200` response) next to parts that were _sent_, and assert parts 3 and 4 completed exactly once. Parts 1 and 2 stay asserted as _sent_ once, so the resume gate and the negative probe are unchanged. Every other check stays.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/e2e/multipart-upload.spec.ts`: `countRequests` gains a `completed` map; the reload test's part 3 and 4 assertions use it. The diagnostic logging is temporary and is removed before commit.
- Only if Step 2 finds a cause in our code: the file holding it (most likely `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts` or `packages/storage/src/fake-multipart.ts`), with a unit test next to it (`route.test.ts` or `fake-multipart.test.ts`). And `app_docs/upload.md` if that fix changes what the doc says about the mock route.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Diagnose the second part-4 PUT (temporary instrumentation, never committed)

- `set -a; . ./.ports.env; set +a` (never edit `.ports.env`). This run: `PORT=9211`, `BACKEND_PORT=9111`. The `/prepare_app` server must already be up, started with the profile's Workspaces dev command; never set `CI=1`.
- In `countRequests` (`apps/studio/e2e/multipart-upload.spec.ts:61-74`), temporarily add listeners that `console.log` to the Playwright output, each line tagged with the test title:
  - `page.on("response", ...)` for mock-route PUTs with `partNumber`: the part number, `response.status()`, the response body when the status is not 200 (`await response.text()`, S3 error XML from `s3Error`, or Next's error page), and `Date.now()`.
  - `page.on("requestfailed", ...)` for the same requests: the part number and `request.failure()?.errorText`.
  - `page.on("console", ...)`: every browser console line (Uppy logs part and request failures at `warning` or `error`).
  - In the reload test only: `page.on("framenavigated")` with a timestamp, so a part-4 PUT can be placed before or after the reload.
- Also temporarily `console.warn` inside `uppy.on("upload-error", ...)` in `apps/studio/src/lib/multipart-upload.ts:115` (error name, message, and `error.request?.status` when present). It shows whether the double send went through the wrapper's retry (`retryUpload`) or stayed inside `fetcher`.
- Run the full suite, `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`, until the double send shows up in the log (the log appears on passing runs too, so look for a second part PUT or a non-200 answer in any run, not only in a failing one). Cap it at 5 runs. These are diagnostic runs, not attempts at a green result. If the server's terminal output is available, read it at the timestamp of the first part-4 answer (a 500 stack trace, a `Compiling` line, `ECONNRESET` or a proxy error).
- Record in the run's report: the first part-4 answer (status and body, or the `requestfailed` error text), whether `upload-error` fired, and whether it happened before or after the reload.
- Look for the same evidence on the other tests' parts too: "uploads in four parts" asserts `{ 1: 1, 2: 1, 3: 1, 4: 1 }` on sent counts and would flake in the same way if this is a transport retry.

### Step 2: Fix the cause if it is in our code

- A `500` whose body or server log shows our handler throwing (an error rethrown by `s3Error`, an `ENOENT` or `EBUSY` from `fake-multipart.ts` writes or reads, a key or upload id rejected wrongly), or any `4xx`: fix it at the source, add a unit test that reproduces it in `route.test.ts` or `fake-multipart.test.ts`, and update `app_docs/upload.md` if the fix changes a documented behaviour. Then still do Step 3: a transport retry stays possible in principle, and the spec must not depend on it never happening.
- Status `0` or `requestfailed` (`net::ERR_CONNECTION_RESET`, `net::ERR_EMPTY_RESPONSE`), or a `5xx` from Next's dev server or the `/studio` rewrite proxy rather than from our handler: the retry is legitimate (Uppy's `fetcher` design). No code change; go to Step 3.
- Never change Uppy's retry settings or the wrapper's backoff to hide it.

### Step 3: Count completed parts and align the reload test's assertions with the spec

- Remove all Step 1 instrumentation from the spec and from `multipart-upload.ts`. `git diff -- apps/studio/src/lib/multipart-upload.ts` must show no change unless Step 2 fixed something there.
- In `countRequests`, keep `parts` (sent PUTs per part, from `page.on("request")`) and `lists` unchanged. Add `completed: Record<number, number>`, filled by a synchronous `page.on("response", (response) => ...)` listener: for a mock-route `PUT` with a `partNumber` and `response.status() === 200`, increment `completed[partNumber]`. Update the comment above the function: requests _sent_ per part, parts _completed_ (a 200 answer) per part, and list requests. Return `{ parts, completed, lists }`.
- In "a reload resumes" (`multipart-upload.spec.ts:241-246`):
  - keep `expect(reelId).toBe(before.reelId)`;
  - keep `expect(counts.parts[1]).toBe(1)` and `expect(counts.parts[2]).toBe(1)` exactly as they are (sent counts: the resume gate the negative probe fires on);
  - replace `expect(counts.parts[3]).toBeGreaterThanOrEqual(1)` with `expect(counts.completed[3]).toBe(1)` and `expect(counts.parts[4]).toBe(1)` with `expect(counts.completed[4]).toBe(1)` (the spec's "parts 3 and 4 complete"; one 200 each, so a resume that stored a part twice still fails);
  - keep `expect(counts.lists - listsBefore).toBeGreaterThanOrEqual(1)`, `expectUploaded` (status, size, one queued job, object byte length and SHA-256), `expectUploadedEventOnce`, the one-reel and the one-job checks.
- Add one line above the assertions: parts 1 and 2 are counted as sent, since the resume must never send them again; parts 3 and 4 as completed, since Uppy's request layer re-sends a request that drops or gets a 5xx without reporting an error.
- If Step 1 showed the same transport retry on another test's parts, apply the same split there only where the test is not a gate on the number of sends: "a failed part is sent again on its own" stays on sent counts (`{ 1: 1, 2: 2, 3: 1, 4: 1 }`, the retry is the subject of the test). Otherwise leave the other tests untouched.
- Check `apps/studio/e2e/multipart-upload.spec.ts` for em-dashes (none allowed) and run `yarn format`.

### Step 4: Re-prove the gate, then prove stability

- Re-run the negative probe from `specs/patch/patch-adw-67f9b648-resume-negative-proof.md` once: temporarily remove the `uppy.setFileState(fileId, { s3Multipart: ... })` block in `apps/studio/src/lib/multipart-upload.ts:81-84`, run `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e -- --grep "a reload resumes"`, confirm it fails on `counts.parts[1]` or `counts.parts[2]`, restore the file (`git diff --quiet -- apps/studio/src/lib/multipart-upload.ts` exits 0 unless Step 2 changed it) and record the failing output in the report. Never commit the probe.
- Run the full suite `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` 5 times in a row, unchanged between runs, and record each result. All 5 must pass. A failure is not re-run: read it, go back to Step 1 with its evidence, and fix it.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `set -a; . ./.ports.env; set +a` - load this run's `PORT` and `BACKEND_PORT` (never edit the file).
- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker` - ESLint over the spec (and any Step 2 fix).
- `yarn turbo run typecheck --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker` - types of the new `completed` map and any fix.
- `yarn knip` - no leftover unused code from the instrumentation.
- `yarn turbo run test --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker` - unit tests, including any Step 2 regression test.
- `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` - the full E2E suite (landing, then studio), run 5 times in a row, all green, after the negative probe in Step 4 has failed as expected and been restored.

## Patch Scope

**Lines of code to change:** about 15 in `apps/studio/e2e/multipart-upload.spec.ts` (a `completed` map and its listener, two assertions, one comment), plus whatever Step 2 finds, if anything (expected 0 to 20 with its unit test).
**Risk level:** low
**Testing required:** the diagnostic runs with the first part-4 answer recorded, the negative probe failing on parts 1 or 2 without the resume, and 5 consecutive green full `yarn test:e2e` runs on this run's ports.
