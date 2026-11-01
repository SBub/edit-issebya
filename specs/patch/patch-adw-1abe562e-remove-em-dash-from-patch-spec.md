# Patch: Remove the literal em-dashes from the docs-and-profile patch spec's grep checks

## Metadata

adw_id: `1abe562e`
review_change_request: `Issue #1: Two lines of specs/patch/patch-adw-1abe562e-docs-and-profile.md contain a literal em-dash (U+2014): line 64 and line 75, each a grep check that searches for an em-dash. AGENTS.md and the profile's Protected section say no em-dashes in any file. Rewrite both lines so the file holds no literal em-dash but each check still searches for one (using $'\xe2\x80\x94'), then confirm grep -rln $'\xe2\x80\x94' specs/patch/patch-adw-1abe562e-* specs/issue-35-* app_docs docs .adw README.md prints nothing. Change nothing else. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-1abe562e-sdlc_planner-export-render-job.md`
**Issue:** `specs/patch/patch-adw-1abe562e-docs-and-profile.md` (untracked, new on this branch) holds a literal U+2014 em-dash on line 64 (``- `grep -n "<U+2014>" app_docs/*.md docs/conditional-docs.md .adw/project.md README.md` returns nothing.``) and line 75 (``- `grep -rn "<U+2014>" app_docs docs .adw/project.md README.md` returns nothing.``). That breaks the "No em-dashes in any file" rule in `AGENTS.md` and the profile's Protected section, and is the only such file among everything this branch adds or changes.
**Solution:** Replace the quoted literal em-dash in each of the two grep commands with the bash ANSI-C escape `$'\xe2\x80\x94'` (the UTF-8 bytes of U+2014), so each check still searches for an em-dash while the file itself contains none. No other line or file changes.

## Files to Modify

- `specs/patch/patch-adw-1abe562e-docs-and-profile.md` (lines 64 and 75 only)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Rewrite line 64

- Replace the line with exactly:
  ``- `grep -n $'\xe2\x80\x94' app_docs/*.md docs/conditional-docs.md .adw/project.md README.md` returns nothing.``
- Only the `"<U+2014>"` argument changes; the leading `- `, the paths and the trailing ` returns nothing.` stay as they are.

### Step 2: Rewrite line 75

- Replace the line with exactly:
  ``- `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md README.md` returns nothing.``
- Only the `"<U+2014>"` argument changes.

### Step 3: Confirm nothing else changed

- The file keeps the same line count as before the edit (`wc -l` before and after) and no other line is touched. No other file is edited.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `grep -rln $'\xe2\x80\x94' specs/patch/patch-adw-1abe562e-* specs/issue-35-* app_docs docs .adw README.md` prints nothing.
2. `sed -n '64p;75p' specs/patch/patch-adw-1abe562e-docs-and-profile.md` shows the two rewritten lines, each holding `$'\xe2\x80\x94'`.
3. `yarn format:check` passes (Prettier over the whole repository, including the edited markdown).

## Patch Scope

**Lines of code to change:** 2
**Risk level:** low
**Testing required:** The em-dash grep over the branch's spec, docs and profile files prints nothing, and the format check passes. The change touches only a spec file, so no build, unit or E2E run is needed.
