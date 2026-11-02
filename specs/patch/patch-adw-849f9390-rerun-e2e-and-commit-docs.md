# Patch: Re-run both E2E suites to completion and commit the step 14 docs

## Metadata

adw_id: `849f9390`
review_change_request: `Issue #1: The spec's E2E validation command, run as PORT=9212 STUDIO_PORT=9112 yarn test:e2e, exited 1. In the landing suite, 139 tests passed and 1 failed: [webkit] e2e/dialog_form.spec.ts:39 'at 1800x830 the dialog shows the whole form' hit the 30s timeout in page.goto("/"). This branch does not touch that spec, and it runs on the shared macOS 14 WebKit container. Because @edit-issebya/studio#test:e2e depends on the landing suite passing, the studio suite never ran. These acceptance criteria are therefore unverified: 4 part requests with SHA-256 and source_bytes 36700160, the retried part 2, reload resume, the B user 404 and signed-out 401, cancel, and the event being sent once. Resolution: No code patch is needed on this branch. Re-run PORT=9212 STUDIO_PORT=9112 yarn test:e2e until the landing webkit spec passes and the studio suite, including multipart-upload.spec.ts, runs to completion, and record its exit status. Also commit the uncommitted step 14 docs (app_docs/upload.md, docs/conditional-docs.md, app_docs/studio.md, app_docs/measurement.md, .adw/project.md). Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-36-adw-849f9390-sdlc_planner-resumable-multipart-footage-upload.md`
**Issue:** The spec's last validation command, `PORT=9212 STUDIO_PORT=9112 yarn test:e2e`, exited 1 because one landing WebKit test (`apps/web/e2e/dialog_form.spec.ts:39`, untouched by this branch) timed out in `page.goto("/")` against the shared macOS 14 WebKit container. turbo's `@edit-issebya/studio#test:e2e` depends on `@edit-issebya/web#test:e2e` (`turbo.json` line 129), so the studio suite, and with it every acceptance criterion of `apps/studio/e2e/multipart-upload.spec.ts` (four 10 MiB parts with SHA-256 and `source_bytes` 36700160, the re-sent part 2, reload resume, B user 404 and signed-out 401 on every route, cancel, `studio_footage_uploaded` sent once), never ran. Separately, the step 14 docs written by the previous patch (`specs/patch/patch-adw-849f9390-upload-docs-and-profile.md`) are still uncommitted: `app_docs/upload.md` and that patch plan are untracked, and `docs/conditional-docs.md`, `app_docs/studio.md`, `app_docs/measurement.md` and `.adw/project.md` are modified.
**Solution:** No code change. Commit the docs (through the lefthook commit gates), make sure the ADW stack carries this branch's migration and the run's dev server is up, then run the unfiltered E2E command until the landing suite passes and the studio suite runs to the end, and record the exit status and the per-suite counts. Fix any failure in this branch's own specs; do not edit `dialog_form.spec.ts` or the WebKit setup in this patch.

## Files to Modify

Use these files to implement the patch:

- `app_docs/upload.md` (commit only, already written)
- `docs/conditional-docs.md` (commit only)
- `app_docs/studio.md` (commit only)
- `app_docs/measurement.md` (commit only)
- `.adw/project.md` (commit only)
- `specs/patch/patch-adw-849f9390-upload-docs-and-profile.md` and this plan (commit only)

No source, test or config file changes, unless Step 4 finds a failure in this branch's studio specs.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Check and commit the step 14 docs

- Confirm the docs are clean: `test -f app_docs/upload.md`, no em-dash (`! grep -n "$(printf '\342\200\224')" app_docs/upload.md app_docs/studio.md app_docs/measurement.md docs/conditional-docs.md .adw/project.md`), still nine `##` headings in `.adw/project.md` (`grep -c '^## ' .adw/project.md` prints 9), and `yarn format:check` passes (run `yarn format` first if it does not, then re-check).
- Stage exactly these paths, by name: `app_docs/upload.md docs/conditional-docs.md app_docs/studio.md app_docs/measurement.md .adw/project.md specs/patch/patch-adw-849f9390-upload-docs-and-profile.md specs/patch/patch-adw-849f9390-rerun-e2e-and-commit-docs.md`. Never `git add -A`; never stage `next-env.d.ts`, `.ports.env`, `.env*`, `.e2e-storage/`, `.turbo/`, `agents/` or `trees/`.
- Commit with `git commit -m "docs: add upload doc and bring studio, measurement and profile docs in step"` plus the body line `adw: patch_agent 849f9390`. No trailers of any kind (no `Co-Authored-By`, no "Generated with", no `Deploy-Preview`). Let lefthook run (prettier, `yarn lint`, `yarn typecheck`, `yarn knip`); never `--no-verify`. If a hook fails, fix the cause and make a new commit attempt.

### Step 2: Make sure the ADW stack and the run's server are ready

- Source the run's ports from `.ports.env` (`set -a; . ./.ports.env; set +a`); never write it. The review's values are `PORT=9212` and `BACKEND_PORT=9112`; use whatever the file holds.
- Apply this branch's migrations (`supabase/migrations/20261101212954_multipart_upload.sql`) to the ADW stack with `.adw/supabase-stack reset`, the only allowed reset. If it fails, report its error and stop. Run no other `supabase` command.
- Check the `/prepare_app` server answers on this run's port: `curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/` and `.../studio` both 200. If it is not up, start it with the Workspaces dev command from `.adw/project.md` (`set -a; . ./.ports.env; set +a; STUDIO_PORT=$BACKEND_PORT E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true E2E_MOCK_STORAGE=true yarn turbo run dev --filter=./apps/web --filter=./apps/studio`) in the background and wait for both URLs. Never set `CI=1`, never touch a server on another port, never start the worker, never start, stop or probe the WebKit container, never set or unset `PW_WEBKIT_WS` or the Supabase variables.

### Step 3: Run the E2E suites to completion and record the result

- Run `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` (in the review: `PORT=9212 STUDIO_PORT=9112 yarn test:e2e`) and save the output, then `echo "exit=$?"`.
- If the only landing failure is the WebKit `dialog_form.spec.ts` timeout in `page.goto("/")` (the shared macOS 14 container, not this branch), run the same command again, up to three runs in total. Do not edit `dialog_form.spec.ts`, its timeout or the Playwright config to get past it.
- Success is a run where the landing suite passes (140 of 140) and turbo starts `@edit-issebya/studio#test:e2e`, which runs every studio spec, including all five tests of `multipart-upload.spec.ts` and the unchanged `upload.spec.ts`, to the end, with exit 0. Record in the run's report: the command, its exit status, the landing and studio pass and fail counts, and each `multipart-upload.spec.ts` test by name with its result.
- If three runs all stop on the same WebKit timeout, the studio suite is still unverified: report the blocker with the three outputs and that the WebKit container is the cause, and note that the flaky landing spec needs its own fix in a separate PR (never paper over it here). Do not run the studio suite outside turbo to claim the criteria pass.

### Step 4: Fix only this branch's failures, if any

- If the studio suite runs and a test in `multipart-upload.spec.ts`, `upload.spec.ts` or another studio spec fails, read the failure and the code it covers (`apps/studio/src/lib/uploader.ts`, `upload-server.ts`, `upload-resume.ts`, `UploadForm.tsx`, the routes under `apps/studio/src/app/api/uploads/s3/multipart/`, the mock route), fix the cause (never weaken the test), update `app_docs/upload.md` if behaviour changed, commit with a `fix:` message, and repeat Step 3.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `git status --porcelain -- app_docs docs .adw/project.md specs/patch`: prints nothing (the docs and both patch plans are committed).
- `git log -1 --format=%B`: the docs commit message has no trailer.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test`: the commit and push gates pass on the committed tree.
- `.adw/supabase-stack reset && yarn turbo run test:db --filter=./apps/studio`: the ADW stack carries the branch's migration and the DB layer passes.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e; echo "exit=$?"`: exits 0, with the landing suite passing and the studio suite, including every `multipart-upload.spec.ts` test, run to completion and passing.

## Patch Scope

**Lines of code to change:** 0 (one commit of already written docs and two patch plans; code only if Step 4 finds a real failure).
**Risk level:** low
**Testing required:** the full E2E command run to completion through both suites with its exit status recorded, plus the commit and push gates and `test:db`.
