# Patch: carry #32's preview fingerprint migration so the local stack can migrate

## Metadata

adw_id: `48ca5f11`
review_change_request: `Issue #1: Two of the spec's validation commands fail, so these criteria are unverified: save_version storing used_free_field, free_field and unexpressed (DB layer), and E2E Verification 8 (version 2 current with the AI columns). supabase migration up --local exits 1 with 'Remote migration versions not found in local migrations directory ... 20261105090000'. The shared stack has #32's 20261105090000_preview_copies_fingerprint.sql applied, which is not on this branch, so 20261106090000_decide_versions.sql was never applied; test:db fails in db-tests/versions.test.ts ('Could not find the function public.save_version(..., p_unexpressed, p_used_free_field)') and upload.spec.ts cannot pass. Resolution: (a) bring #32's migration onto this branch, then run supabase migration up --local, test:db and the upload E2E, or (b) the owner reconciles the stack by hand. Keep the 20261106 timestamp. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-33-adw-48ca5f11-sdlc_planner-decide-step-claude-schema.md`
**Issue:** The shared local Supabase stack has already applied `20261105090000` (from #32, PR #55,
open, not on develop). That migration file is missing from this branch, so the Supabase CLI refuses
`supabase migration up --local`. As a result this branch's `20261106090000_decide_versions.sql` is never
applied, `test:db` (`versions.test.ts`) fails on the new `save_version` signature, and
`upload.spec.ts` (Verification 8) cannot pass. ADW may run only `supabase migration up --local`:
never repair, reset or start.
**Solution:** This is option (a) without the full branch merge. The review's route through develop
is blocked: develop ends at `20261101090000`, and PRs #52 to #55 (#29 to #32) are all still open.
Merging `origin/feat/issue-32-adw-b7898314-live-preview-hyperframes-player` straight into this
branch causes six content conflicts (`upload.spec.ts`, `LiveReel.tsx`, `reels.ts`,
`process-job.ts`, `recording-steps.ts`, `step-store.ts`), which is far beyond a patch. So copy just
the one migration file from #32's branch, byte for byte. It is self-contained: it adds the nullable,
checked column `reels.preview_copies_fingerprint` and depends on nothing else in #32. No DB test
asserts the `reels` column set (`steps-measurements.test.ts` covers `steps` only). Because the
contents are identical on both sides, git merges the file cleanly whichever of #32 and #33 lands
first. With the file present, the local history matches the stack, `migration up` applies only
`20261106090000`, and CI's fresh stack applies both in timestamp order. `20261106090000` keeps its
timestamp so it still sorts after #32's.

## Files to Modify

Use these files to implement the patch:

- `supabase/migrations/20261105090000_preview_copies_fingerprint.sql` (new, copied unchanged from
  #32's branch; no other file changes, no documentation change, since #32 documents its own column)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Copy the migration byte for byte from #32's branch

- `git fetch origin feat/issue-32-adw-b7898314-live-preview-hyperframes-player`
- `git checkout origin/feat/issue-32-adw-b7898314-live-preview-hyperframes-player -- supabase/migrations/20261105090000_preview_copies_fingerprint.sql`
- Confirm the copy matches exactly:
  `git diff --quiet origin/feat/issue-32-adw-b7898314-live-preview-hyperframes-player -- supabase/migrations/20261105090000_preview_copies_fingerprint.sql`
  (exit 0). Never edit the file: any byte difference would turn the later merge into a conflict.
- Do not rename or touch `supabase/migrations/20261106090000_decide_versions.sql`.

### Step 2: Apply the pending migration to the shared stack

- Run `supabase migration list --local` and check that every local
  version, up to and including `20261105090000`, shows as applied remotely and that only
  `20261106090000` is pending.
- `supabase migration up --local`. It must exit 0 and apply only `20261106090000_decide_versions.sql`.
  If it fails, report the error and stop. Never run `db reset`, `migration repair`, `start` or
  `stop` (option (b), the owner's manual reconcile, is then the only path).

### Step 3: Commit

- Stage only the new migration file and commit it as
  `chore: carry the preview fingerprint migration from #32`, through lefthook (no `--no-verify`,
  no trailers).

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `supabase migration up --local` (exits 0; afterwards `supabase migration list --local` shows
  `20261106090000` applied)
- `yarn turbo run test:db --filter=./apps/studio` (`versions.test.ts` passes: `save_version` stores
  `used_free_field`, `free_field` and `unexpressed`)
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` against the `/prepare_app` server
  (`upload.spec.ts` passes Verification 8: version 2 current with the AI columns)
- `grep -rn "$(printf '\342\200\224')" app_docs docs specs apps packages supabase fixtures --include='*.md' --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.json' ; test $? -eq 1`

## Patch Scope

**Lines of code to change:** 10 (one migration file copied unchanged; no hand-written code)
**Risk level:** low
**Testing required:** migration up on the shared stack, the studio DB layer, the unfiltered gates
and the E2E suites (upload spec)
