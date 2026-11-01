# Patch: Escape the em-dash in the profile patch plan's grep

## Metadata

adw_id: `a6bafcdf`
review_change_request: `Issue #1: The spec's Validation Command grep -rn $'\u2014' over app_docs docs specs apps/worker/src apps/studio/src apps/studio/e2e supabase .adw must return nothing (AGENTS.md: no em-dashes in any file). It hits specs/patch/patch-adw-a6bafcdf-profile-tests-tool-clips.md line 56, whose Validation step writes the grep with a literal U+2014 character. Resolution: replace that literal character with the escape $'\u2014' (the form the main spec uses), then confirm grep -rn $'\u2014' specs .adw app_docs docs apps/worker/src apps/studio/src apps/studio/e2e prints nothing. Do not write a literal em-dash in any new patch plan either. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-30-adw-a6bafcdf-sdlc_planner-background-removal-head-tracking-previews.md`
**Issue:** The untracked patch plan `specs/patch/patch-adw-a6bafcdf-profile-tests-tool-clips.md` holds a literal U+2014 character on line 56 (its Validation step, `grep -rn $'<U+2014>' .adw`), so the spec's no-em-dash check (main spec line 574) fails on this branch.
**Solution:** Rewrite line 56 to use the ANSI-C escape `$'\u2014'` (backslash, `u2014`), the same form as the main spec's line 574, so the file contains no U+2014 character while the command it describes stays equivalent.

## Files to Modify

Use these files to implement the patch:

- `specs/patch/patch-adw-a6bafcdf-profile-tests-tool-clips.md` (line 56 only)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Replace the literal em-dash on line 56

- Edit line 56 of `specs/patch/patch-adw-a6bafcdf-profile-tests-tool-clips.md` so it reads exactly:
  ``- `grep -rn $'\u2014' .adw` returns nothing: no em-dashes.``
- Type the six ASCII characters `\u2014` inside `$'...'`; never paste the U+2014 character itself. Change nothing else in the file.
- Make the change with `perl -CSD -pi -e 's/\x{2014}/\\u2014/g' specs/patch/patch-adw-a6bafcdf-profile-tests-tool-clips.md`, not with the Edit or Write tool: those tools turn a typed `\u2014` escape into the real U+2014 character, which is how line 56 got it.

### Step 2: Confirm no em-dash remains in the scoped paths

- Run `grep -rn $'\u2014' specs .adw app_docs docs apps/worker/src apps/studio/src apps/studio/e2e` and confirm it prints nothing (exit code 1).
- `supabase/config.toml` lines 363 and 364 carry em-dashes from the Supabase CLI's generated comments; they predate this run and are outside this patch's scope, so the confirmation command above deliberately omits `supabase`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -rn $'\u2014' specs .adw app_docs docs apps/worker/src apps/studio/src apps/studio/e2e` prints nothing.
- `grep -n 'u2014' specs/patch/patch-adw-a6bafcdf-profile-tests-tool-clips.md` shows line 56 with the escaped form.
- `yarn format:check` passes (the only other check a spec-only change can affect).

## Patch Scope

**Lines of code to change:** 1
**Risk level:** low
**Testing required:** The grep checks above and `yarn format:check`; the change touches `specs/` only, so no build, unit or E2E run is affected.
