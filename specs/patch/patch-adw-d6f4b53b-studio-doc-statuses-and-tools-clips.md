# Patch: List the three new reel statuses in the studio doc and name both tool-test clips in the profile

## Metadata

adw_id: `d6f4b53b`
review_change_request: `Issue #2: Some of spec step 10's documentation is missing. The step requires app_docs/studio.md to list the three new reel statuses and .adw/project.md Tests to say the tool tests run 'on the committed clips (short-speech.mp4, short-person.mp4)'. Neither file is in the diff, and grep finds 'removing_background' in neither. The ADW document phase edits exactly one feature doc (app_docs/pipeline.md) plus its index line, so it will not cover these two. The pipeline.md and conditional-docs.md updates in the same step can be left to the document phase. Resolution: On this branch, add 'removing_background', 'tracking_head' and 'making_previews' (before 'processed') wherever app_docs/studio.md lists the reel statuses. In .adw/project.md's Tests section, change the test:tools sentence from 'on the committed clip' to 'on the committed clips (short-speech.mp4, short-person.mp4)', with no heading changes. Use no em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-30-adw-d6f4b53b-sdlc_planner-pipeline-background-head-track-previews.md`
**Issue:** Spec step 10 requires two documentation edits the document phase will not make:
`app_docs/studio.md` must list `removing_background`, `tracking_head` and `making_previews`
wherever it lists the reel statuses, and `.adw/project.md` Tests must say the tool tests run on
both committed clips. Neither file is in the branch diff.
**Solution:** Two text-only edits. In `app_docs/studio.md` the only place the reel statuses are
listed is the Reels bullet for `20261031105245_studio_skeleton.sql` (line 51 to 52:
`uploading | uploaded | received | failed`). That list describes the skeleton migration and stays
true, so append one sentence to the same bullet giving the current full set (the order of
`REEL_STATUSES` in `apps/studio/src/lib/reels.ts`), with the three new statuses before `processed`.
In `.adw/project.md` replace the one phrase in the Tests paragraph. `app_docs/pipeline.md` and
`docs/conditional-docs.md` are left to the document phase.

## Files to Modify

Use these files to implement the patch:

- `app_docs/studio.md`
- `.adw/project.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add the statuses to the studio doc's Reels bullet

- In `app_docs/studio.md`, section `### Reels`, the bullet beginning
  `` - `supabase/migrations/20261031105245_studio_skeleton.sql`: table `public.reels` ``, keep the
  existing text and, after `The table is in the `supabase_realtime` publication.`, append:
  ``Later migrations widen the status check; the current set (`REEL_STATUSES` in `apps/studio/src/lib/reels.ts`) is `uploading`, `uploaded`, `received`, `converting`, `transcribing`, `retiming`, `removing_background`, `tracking_head`, `making_previews`, `processed`, `failed`.``
- Wrap the bullet's continuation lines at about 100 columns with two-space indent, like the rest of
  the file. Do not name a migration file for the new statuses (patch 1 creates it with
  `supabase migration new`, so its version is not known here).
- Run `grep -n "status" app_docs/studio.md` and confirm no other line lists the reel statuses as a
  set (line 187's Rule about writing `status` is not a list and stays unchanged).

### Step 2: Name both clips in the profile's Tests section

- In `.adw/project.md`, `## Tests`, replace exactly
  `HyperFrames on the committed clip; on the owner's Mac only, never in CI)` with
  ``HyperFrames on the committed clips (`short-speech.mp4`, `short-person.mp4`); on the owner's Mac only, never in CI)``.
- Re-wrap only that paragraph if the line grows past the file's width; no other wording changes, no
  `##` heading renamed, added or reordered.

### Step 3: Format and check for em-dashes

- `yarn format` (Prettier may re-wrap the edited Markdown), then
  `grep -n "—" app_docs/studio.md .adw/project.md` must print nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -n "removing_background" app_docs/studio.md` and `grep -n "short-person.mp4" .adw/project.md`: each prints a match.
- `grep -c "^## " .adw/project.md`: prints `9`.
- `yarn format:check`: Prettier passes over the repository.
- `yarn knip`: unchanged, still clean.
- `yarn lint && yarn typecheck && yarn test`: the commit and push hooks' checks still pass (docs-only change, no code touched).

## Patch Scope

**Lines of code to change:** about 6 lines of Markdown across two files
**Risk level:** low
**Testing required:** formatting and grep checks; the hook checks run unchanged since no code moves
