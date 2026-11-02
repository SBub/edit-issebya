# Patch: Replace the literal em-dash in the decide-step spec's grep command

## Metadata

adw_id: `b632a861`
review_change_request: `Issue #1: The spec's last Validation Command (the em-dash grep over app_docs, docs, apps/worker/src, packages/edit/src, the spec and supabase/migrations) must print nothing. It prints one line, specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md:610, the grep command itself, written with a literal em-dash character. That character is the only em-dash this branch adds, but it breaks the AGENTS.md / profile Protected rule 'No em-dashes in any file' and the acceptance criterion 'no em-dashes in any changed file'. Resolution: edit line 610 of the spec to replace the literal em-dash inside $'...' with the escape \u2014, as specs/patch/patch-adw-b632a861-ai-script-single-envelope.md already does, then re-run the grep and confirm it prints nothing. No other file needs a change. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md`
**Issue:** Line 610 of the spec (the last item of `## Validation Commands`) writes its own grep
pattern as `$'<literal U+2014>'`. The grep therefore matches the spec file itself, so the
validation command prints a line instead of nothing, and the branch adds an em-dash in violation
of the profile's Protected rule "No em-dashes in any file".
**Solution:** Rewrite the pattern on that line with the bash ANSI-C escape `$'\u2014'`, which
expands to the em-dash at run time but leaves no em-dash character in the file. This is the form
`specs/patch/patch-adw-b632a861-ai-script-single-envelope.md` (line 50) already uses.

## Files to Modify

- `specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md` (line 610 only)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Replace the literal em-dash on line 610 of the spec

- Line 610 currently reads (with `<EM DASH>` standing for the literal U+2014 character):
  ``- `grep -rn $'<EM DASH>' app_docs docs apps/worker/src packages/edit/src specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md supabase/migrations`:``
- Change only the quoted pattern so the line reads:
  ``- `grep -rn $'\u2014' app_docs docs apps/worker/src packages/edit/src specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md supabase/migrations`:``
- Keep the rest of the line and line 611 (`  must print nothing (no em-dashes).`) unchanged. Make the change with
  `perl -CSD -i -pe 's/\x{2014}/\\u2014/ if $. == 610'` (the replacement must be the six ASCII characters backslash, u, 2, 0, 1, 4; the Edit and
  Write tools turn a typed backslash-u escape back into the literal em-dash, so do not use them
  for this line); do not touch any other line or file.

### Step 2: Confirm no em-dash remains in any changed file

- Run the spec's grep (Validation below) and confirm it prints nothing.
- Run the same grep over every file this branch changes against `develop` and confirm it prints
  nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -rn $'\u2014' app_docs docs apps/worker/src packages/edit/src specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md specs/patch/patch-adw-b632a861-ai-script-single-envelope.md specs/patch/patch-adw-b632a861-remove-spec-em-dash.md supabase/migrations`: must print nothing.
- `git diff --name-only develop... | xargs grep -n $'\u2014'`: must print nothing (every
  file the branch changes is em-dash free).
- `yarn format:check`: whole-repository formatting still passes after the Markdown edit.

## Patch Scope

**Lines of code to change:** 1 (one character in a Markdown spec)
**Risk level:** low
**Testing required:** the em-dash grep and the format check only; no code, test or build input
changes, so lint, typecheck, unit, build and E2E are unaffected.
