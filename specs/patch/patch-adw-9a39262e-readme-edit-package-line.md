# Patch: add packages/edit to the README layout block

## Metadata

adw_id: `9a39262e`
review_change_request: `Issue #1: Spec step 17 requires a new line in README.md's layout block: packages/edit/ the edit format and builder the studio and the worker share, workspace @edit-issebya/edit, and the Acceptance Criteria list README.md as updated. README.md is not in the diff. Its layout block still lists only apps/web, apps/studio, apps/worker and packages/storage. The implementor deferred this to the document phase, but /document never edits README.md. Resolution: add one line to the code block in README.md after the packages/storage/ line, keep the column alignment, no em-dashes, then run yarn format:check. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-31-adw-9a39262e-sdlc_planner-edit-model-builder-versions.md`
**Issue:** The spec (step 17, line 538, and the Acceptance Criteria) requires `README.md`'s repository layout block to list `packages/edit/`. The block (README.md lines 8 to 15) still lists only `apps/web/`, `apps/studio/`, `apps/worker/` and `packages/storage/`, and no later phase edits `README.md`.
**Solution:** Insert one line after `packages/storage/` (README.md line 12). The description column starts at column 19 (`packages/storage/` is 17 characters plus one space), so `packages/edit/` (14 characters) takes four spaces of padding; no other line changes.

## Files to Modify

- `README.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add the packages/edit line to the layout block

- In `README.md`, directly after line 12
  (`packages/storage/ the storage library the studio and the worker share, workspace @edit-issebya/storage`)
  and before `supabase/         local Supabase config and migrations`, insert exactly:
  `packages/edit/    the edit format and builder the studio and the worker share, workspace @edit-issebya/edit`
- Four spaces between `packages/edit/` and `the`, so the description aligns with every other line at column 19. Do not change the padding of any other line.
- No em-dashes; touch nothing else in `README.md`.

### Step 2: Check formatting

- Run `yarn format:check` from the worktree root; it must pass (Prettier leaves fenced code blocks unchanged, so this only confirms nothing else drifted).

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -n 'packages/edit/    the edit format and builder the studio and the worker share, workspace @edit-issebya/edit' README.md` prints line 13.
- `grep -n $'\u2014' README.md` prints nothing (no em-dashes).
- `yarn format:check`

## Patch Scope

**Lines of code to change:** 1 (one line added to `README.md`)
**Risk level:** low
**Testing required:** formatting check only; a README line has no code, test or rendered surface.
