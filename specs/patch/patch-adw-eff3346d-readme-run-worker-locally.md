# Patch: README repository layout and "Run the worker locally"

## Metadata

adw_id: `eff3346d`
review_change_request: `Issue #1: Spec step 15 requires the root README.md to add apps/worker/ and packages/storage/ to the repository layout and a "Run the worker locally" section (fill apps/worker/.env.development, yarn workspace @edit-issebya/worker doctor, yarn workspace @edit-issebya/worker worker, once for one job, and a note that yarn dev does not start it). README.md is not in git diff origin/develop --stat. Resolution: edit the root README.md on this branch: add apps/worker/ and packages/storage/ to the repository-layout list, and add a "Run the worker locally" section with run instructions only. No feature description and no em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-43-adw-eff3346d-sdlc_planner-reel-upload-job-queue-worker.md`
**Issue:** Spec step 15 ("Docs", the `README.md (root)` bullet) was not implemented. The root
`README.md` still lists `packages/` as "none yet", does not mention `apps/worker/` or
`packages/storage/`, and has no instructions for running the worker. The document phase only
edits `app_docs/` and the docs index, so it will not fill the gap.
**Solution:** Edit the root `README.md` only: add `apps/worker/` and `packages/storage/` to the
layout block (replacing the stale `packages/ ... (none yet)` line), and add a "Run the worker
locally" subsection after "Run the studio locally" holding run commands only.

## Files to Modify

- `README.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Update the repository layout block

- In the fenced layout block near the top of `README.md`, keep the existing column alignment and
  add after the `apps/studio/` line:
  `apps/worker/     the job worker (Node, runs on the owner's machine), workspace @edit-issebya/worker`
- Replace the line `packages/        shared libraries, added once two apps need one (none yet)` with
  `packages/storage/ the storage library the studio and the worker share, workspace @edit-issebya/storage`
  (adjust the padding of every line in the block so the descriptions stay aligned if the longer
  path needs it).
- Leave the `supabase/` and `turbo.json` lines as they are.

### Step 2: Add the "Run the worker locally" subsection

- Insert a `### Run the worker locally` subsection directly after the "Run the studio locally"
  subsection (after its "Open `http://localhost:3000/studio`..." paragraph) and before `## Checks`.
- Content, run instructions only, no description of what the worker does:

  ````md
  ### Run the worker locally

  Copy `apps/worker/.env.example` to `apps/worker/.env.development` and fill it (the local Supabase
  values from `supabase status`, the R2 worker keys). Then, from the repository root:

  ```bash
  yarn workspace @edit-issebya/worker doctor   # checks the configuration and connections
  yarn workspace @edit-issebya/worker worker   # long-running: keeps taking jobs until stopped
  yarn workspace @edit-issebya/worker once     # takes one job, then exits
  ```

  `yarn dev` does not start the worker; run it in its own terminal.
  ````

- Use commas, colons and parentheses only; no em-dashes.

### Step 3: Format

- Run `yarn format` so Prettier settles the Markdown, then confirm the layout block and the new
  subsection read as intended.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`: Prettier over the whole repository, including `README.md`.
- `grep -nP "\x{2014}" README.md`: returns nothing (no em-dashes).
- `grep -nE "apps/worker/|packages/storage/|Run the worker locally|worker doctor|worker worker|worker once|yarn dev. does not start" README.md`:
  shows the two layout lines, the subsection heading, the three commands and the `yarn dev` note.
- `git diff origin/develop --stat -- README.md`: `README.md` now appears in the branch diff.
- `yarn lint && yarn typecheck && yarn knip`: the commit hook gates, unchanged by a docs edit.

## Patch Scope

**Lines of code to change:** about 15 lines in `README.md`
**Risk level:** low
**Testing required:** format check and em-dash grep; documentation only, no code or test changes.
