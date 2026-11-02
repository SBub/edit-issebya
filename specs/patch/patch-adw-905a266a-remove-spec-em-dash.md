# Patch: Remove the literal em-dash from the issue 46 plan's own check command

## Metadata

adw_id: `905a266a`
review_change_request: `Issue #1: The branch adds an em-dash, which breaks a repo-wide invariant (AGENTS.md "No em-dashes in any file", restated in the profile's Protected section). specs/issue-46-adw-905a266a-sdlc_planner-webkit-server-worktree-env.md:184 holds a literal U+2014 inside its own check command (grep -rn "<U+2014>" .adw app_docs docs specs/issue-46-*). Because of this, the spec's step 6 check ("prints nothing") fails when run verbatim: it prints exactly that line. Resolution: edit line 184 so the file no longer holds a literal em-dash but the check still finds one, for example grep -rn $'\xe2\x80\x94' .adw app_docs docs specs/issue-46-*. Then run that command and confirm it prints nothing and exits 1. Change nothing else. Severity: blocker`

(The em-dash in the original request is written here as `<U+2014>` so this plan does not break the
same invariant.)

## Issue Summary

**Original Spec:** `specs/issue-46-adw-905a266a-sdlc_planner-webkit-server-worktree-env.md`
**Issue:** Line 184 of the plan (step 6, "Check the invariants") writes its no-em-dash check as
`grep -rn "<U+2014>" ...` with a literal U+2014 character. That is the only em-dash on the branch,
it violates the "No em-dashes in any file" invariant (`AGENTS.md`, `.adw/project.md` Protected), and
it makes the check fail on itself: run verbatim, it prints its own line.
**Solution:** Replace the literal character in that one command with the bash/zsh ANSI-C byte escape
`$'\xe2\x80\x94'` (the UTF-8 bytes of U+2014). The shell expands it to an em-dash at run time, so
the check still detects one, but the file itself holds only ASCII there.

## Files to Modify

- `specs/issue-46-adw-905a266a-sdlc_planner-webkit-server-worktree-env.md` (line 184 only)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Rewrite the pattern on line 184

- Current line 184 (the U+2014 shown as `<U+2014>`):
  ``- `grep -rn "<U+2014>" .adw app_docs docs specs/issue-46-*` prints nothing (no em-dashes).``
- Replace it with exactly:
  ``- `grep -rn $'\xe2\x80\x94' .adw app_docs docs specs/issue-46-*` prints nothing (no em-dashes).``
- Use the Edit tool on that line alone; touch no other line, file or wording.

### Step 2: Confirm the file and the branch hold no em-dash

- Run the rewritten check verbatim from the worktree root; it must print nothing and exit 1.
- Confirm the escape still matches a real em-dash (proves the check is not vacuous).

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `grep -rn $'\xe2\x80\x94' .adw app_docs docs specs/issue-46-*; echo "exit=$?"` prints only
   `exit=1`.
2. `printf 'a\xe2\x80\x94b\n' | grep -c $'\xe2\x80\x94'` prints `1` (the escape matches an
   em-dash).
3. `git diff --name-only HEAD` lists only
   `specs/issue-46-adw-905a266a-sdlc_planner-webkit-server-worktree-env.md`, and `git diff HEAD`
   shows a one-line change on line 184.
4. `yarn format:check` passes (the only whole-repository check that reads `specs/`; the change is
   root-only, so no filtered lint, typecheck, unit, build or E2E run is affected).

## Patch Scope

**Lines of code to change:** 1
**Risk level:** low
**Testing required:** Run the rewritten grep (prints nothing, exit 1), prove the escape matches an
em-dash, and `yarn format:check`. No app code changes, so no unit, build or E2E run is needed.
