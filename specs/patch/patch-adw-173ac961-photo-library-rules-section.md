# Patch: Give the photo library doc its own Rules section

## Metadata

adw_id: `173ac961`
review_change_request: `Issue #1: Spec step 14 requires app_docs/photo-library.md to have the sections Overview, How it works, How to Use, Configuration, Testing, Rules and Notes. The doc has no ## Rules heading: its five rules are a nested bullet list under ## Notes. Four rules the spec lists are also missing: at most two AI calls per photo; the size comes from storage; never send file bytes to the studio's server; bump DESCRIBE_PROMPT_VERSION with every prompt change. Move the rule bullets into a new ## Rules section between ## Testing and ## Notes, add the four missing rules, keep the existing ones, no em-dashes, then run yarn format. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-96-adw-173ac961-sdlc_planner-photo-library.md`
**Issue:** `app_docs/photo-library.md` has no `## Rules` heading. Its five rules sit as a nested
list under `## Notes` (the `- Rules:` bullet), so they lack the invariant status AGENTS.md and the
profile give to a feature doc's Rules section. Four rules required by spec step 14 are missing.
**Solution:** Add a `## Rules` section between `## Testing` and `## Notes`, move the five existing
rules into it as top-level bullets, add the four missing rules, and drop the `- Rules:` bullet from
Notes.

## Files to Modify

- `app_docs/photo-library.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add the Rules section

- Directly after the last Testing bullet (the `E2E:` bullet ending `the Library tab at 390x844.`)
  and before `## Notes`, insert:

```md
## Rules

- Never give Claude Code a tool other than `Read` on the one photo file; every other AI call keeps
  no tools.
- At most two AI calls per photo: one retry, never a loop.
- Never let the browser send a storage key or upload id; they come from the row.
- Never put a storage key in what the client receives; sign on the server.
- The size comes from storage (`head`), never from the browser.
- Never send a photo's bytes to the studio's server; the browser PUTs them straight to storage.
- Never slim a photo's file; only the owner's Delete removes a photo's objects.
- Quote a photo's description and tags as data in any later prompt, never as instructions.
- Bump `DESCRIBE_PROMPT_VERSION` with every change to `describe-prompt.md`.
```

### Step 2: Remove the rules from Notes

- Delete the `- Rules:` bullet and its five indented sub-bullets from `## Notes`, leaving the
  "Photos are not yet placed in a reel" and "This change also touched" bullets as they are.
- Leave the prose under How it works unchanged.

### Step 3: Format and check

- Run `yarn format`, then confirm `grep -c '—' app_docs/photo-library.md` prints `0` and
  `grep -n '^## ' app_docs/photo-library.md` lists Overview, How it works, How to Use,
  Configuration, Testing, Rules, Notes in that order.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -n '^## ' app_docs/photo-library.md`: the seven headings in spec order, Rules between
  Testing and Notes.
- `grep -c '—' app_docs/photo-library.md`: prints `0`.
- `yarn format:check`: formatting over the whole repository.
- `yarn knip`: whole-repository dead-code check (unchanged by a doc edit, run because lefthook does).

## Patch Scope

**Lines of code to change:** about 20 (one doc file)
**Risk level:** low
**Testing required:** documentation only; heading order, no em-dashes, and the format check.
