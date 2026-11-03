# Patch: Remove the literal em-dash from the behind-speaker docs patch plan

## Metadata

adw_id: `182ee234`
review_change_request: `Issue #2: AGENTS.md and the profile's Protected section say 'No em-dashes in any file'. The new, untracked specs/patch/patch-adw-182ee234-behind-speaker-docs.md contains the em-dash character (U+2014) twice, at lines 126 and 132, inside its grep check commands (a grep for the literal character). This file will be committed with the run. Every other file the branch adds or changes is free of em-dashes (checked with grep for U+2014). Resolution: Fixable on this branch. In specs/patch/patch-adw-182ee234-behind-speaker-docs.md, rewrite the two check lines without the literal character, for example grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md, or 'grep for U+2014 (the em-dash)'. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/patch/patch-adw-182ee234-behind-speaker-docs.md`
**Issue:** The untracked patch plan `specs/patch/patch-adw-182ee234-behind-speaker-docs.md` holds the
em-dash character (U+2014) literally at lines 126 and 132, inside its two `grep -rn "<em-dash>" app_docs docs .adw/project.md`
check commands. AGENTS.md and the profile's Protected section forbid em-dashes in any file, and this
file is committed with the run.
**Solution:** Rewrite both grep commands to match the em-dash by its UTF-8 bytes through Bash ANSI-C
quoting, `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md`, so the check still works and the
file no longer contains the character. Nothing else in that file or elsewhere changes.

## Files to Modify

Use these files to implement the patch:

- `specs/patch/patch-adw-182ee234-behind-speaker-docs.md` (lines 126 and 132 only)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Rewrite the check in Step 4 (line 126)

- Replace ``- Check: `grep -rn "<em-dash>" app_docs docs .adw/project.md` returns nothing, and`` with
  ``- Check: `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md` (the em-dash, U+2014) returns nothing, and``.
- Leave the following line (`` `git diff origin/develop --stat -- app_docs docs .adw` lists all ten files. ``) unchanged.

### Step 2: Rewrite the Validation command (line 132)

- Replace ``- `grep -rn "<em-dash>" app_docs docs .adw/project.md` (no output)`` with
  ``- `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md` (no output)``.

### Step 3: Format

- Run `yarn format` so Prettier settles the Markdown (it may rewrap the lengthened line 126).

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -c $'\xe2\x80\x94' specs/patch/patch-adw-182ee234-behind-speaker-docs.md` prints `0`.
- `grep -rln $'\xe2\x80\x94' specs/patch/patch-adw-182ee234-*.md` prints nothing (no plan of this run holds the character).
- `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md` still runs and prints nothing (the rewritten check works).
- `yarn format:check`

## Patch Scope

**Lines of code to change:** 2 lines of Markdown, no code
**Risk level:** low
**Testing required:** the grep checks and `yarn format:check` above; no unit, DB or E2E test is affected.
