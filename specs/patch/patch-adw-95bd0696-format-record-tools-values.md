# Patch: Prettier-format the record-tools-values patch plan

## Metadata

adw_id: `95bd0696`
review_change_request: `Issue #2: The validation command yarn format:check exits 1 with '[warn] specs/patch/patch-adw-95bd0696-record-tools-values.md: Code style issues found'. Every other changed or new file is formatted. Resolution: Run yarn format (or yarn prettier --write specs/patch/patch-adw-95bd0696-record-tools-values.md) and confirm yarn format:check exits 0. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`
**Issue:** `yarn format:check` (the profile's format check, whole repository, also run in CI) failed on the untracked patch plan `specs/patch/patch-adw-95bd0696-record-tools-values.md`, which was written without passing through Prettier.
**Solution:** Rewrite that one file with Prettier, then re-run the repository-wide format check. A check while planning shows the file now passes and `yarn format:check` exits 0. The write is idempotent, so the steps below still apply and only confirm the result. This patch plan is Prettier-formatted too, so it does not cause the same failure.

## Files to Modify

- `specs/patch/patch-adw-95bd0696-record-tools-values.md` (whitespace and markdown layout only, no content change)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Format the flagged file

- From the worktree root run `yarn prettier --write specs/patch/patch-adw-95bd0696-record-tools-values.md`.
- Do not run `yarn format` over the whole tree, and do not edit any other file. Every other file already passes.

### Step 2: Check that only layout changed

- Read the file and confirm the wording is unchanged. Prettier only changes list markers, blank lines, table padding and line wrapping.
- Confirm it contains no em-dashes (`grep -n $'\u2014' specs/patch/patch-adw-95bd0696-record-tools-values.md` prints nothing).

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn prettier --check specs/patch/patch-adw-95bd0696-record-tools-values.md specs/patch/patch-adw-95bd0696-format-record-tools-values.md`: prints "All matched files use Prettier code style!".
2. `yarn format:check`: exits 0.
3. `yarn knip`: exits 0 (whole repository, unaffected by a markdown change, run as part of the commit hook set).

## Patch Scope

**Lines of code to change:** 0 lines of code. Prettier changes a few whitespace or layout lines in one markdown file.
**Risk level:** low
**Testing required:** Only the format check. The change is to a file under `specs/`, so no unit, DB, tool or E2E run is affected, and no docs need updating.
