# Patch: Escape the em-dash in the README patch plan's grep

## Metadata

adw_id: `9a39262e`
review_change_request: `Issue #1: AGENTS.md and the profile's Protected section say "No em-dashes in any file", and the spec's Acceptance Criteria require "no em-dashes anywhere". The untracked patch plan specs/patch/patch-adw-9a39262e-readme-edit-package-line.md has a literal U+2014 character on line 40 (its Validation bullet: grep -n '<U+2014>' README.md). The commit step will add this file to the branch, so merging would break the invariant. Issue 30 hit exactly this and fixed it with specs/patch/patch-adw-a6bafcdf-escape-em-dash-in-patch-plan.md. git grep $'\u2014' HEAD finds no other em-dash this branch added (the two in supabase/config.toml lines 363 and 364 also exist on develop). Resolution: replace the literal character on line 40 with the ANSI-C escape $'\u2014', using perl rather than the Edit or Write tool, then confirm grep -rn $'\u2014' specs .adw app_docs docs README.md packages/edit apps/worker/src apps/studio/src apps/studio/e2e prints nothing and yarn format:check passes. Do not write a literal em-dash in any new patch plan. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-31-adw-9a39262e-sdlc_planner-edit-model-builder-versions.md`
**Issue:** The untracked patch plan `specs/patch/patch-adw-9a39262e-readme-edit-package-line.md` holds a literal U+2014 character on line 40 (its Validation bullet, `grep -n '<U+2014>' README.md`), which breaks the "no em-dashes in any file" invariant (AGENTS.md, profile Protected) and the spec's Acceptance Criteria once the commit step adds the file.
**Solution:** Rewrite line 40 so the grep uses the ANSI-C escape `$'\u2014'` (the six ASCII characters `\u2014` inside `$'...'`), the form the issue 30 fix and the main spec use. The file then holds no U+2014 character and the command it describes stays equivalent.

## Files to Modify

Use these files to implement the patch:

- `specs/patch/patch-adw-9a39262e-readme-edit-package-line.md` (line 40 only)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Replace the literal em-dash on line 40

- Run, from the worktree root:
  `perl -CSD -pi -e "s/'\x{2014}'/\\\$'\\\\u2014'/g; s/\x{2014}/\\\\u2014/g" specs/patch/patch-adw-9a39262e-readme-edit-package-line.md`
  The first substitution turns the quoted `'<U+2014>'` into `$'\u2014'` (so the grep stays a real ANSI-C escape, not a search for the literal text `\u2014`); the second catches any other stray U+2014 the same way the issue 30 fix did.
- Line 40 must then read exactly:
  ``- `grep -n $'\u2014' README.md` prints nothing (no em-dashes).``
- Do not use the Edit or Write tool for this: they turn a typed `\u2014` escape back into the real U+2014 character. Change nothing else in the file.

### Step 2: Confirm no em-dash remains in the scoped paths

- Run `grep -rn $'\u2014' specs .adw app_docs docs README.md packages/edit apps/worker/src apps/studio/src apps/studio/e2e` and confirm it prints nothing (exit code 1).
- `supabase/config.toml` lines 363 and 364 carry em-dashes from the Supabase CLI's generated comments; they also exist on `develop` and are outside this patch's scope, so the command deliberately omits `supabase`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -rn $'\u2014' specs .adw app_docs docs README.md packages/edit apps/worker/src apps/studio/src apps/studio/e2e` prints nothing.
- `sed -n 40p specs/patch/patch-adw-9a39262e-readme-edit-package-line.md` shows ``- `grep -n $'\u2014' README.md` prints nothing (no em-dashes).``
- `yarn format:check` passes (the only commit-hook check a `specs/`-only change can affect).

## Patch Scope

**Lines of code to change:** 1
**Risk level:** low
**Testing required:** The grep checks above and `yarn format:check`; the change touches `specs/` only, so no build, unit or E2E run is affected.
