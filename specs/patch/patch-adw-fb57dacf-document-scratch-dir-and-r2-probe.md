# Patch: document the scratch folder creation and the doctor's R2 write probe

## Metadata

adw_id: `fb57dacf`
review_change_request: `Issue #1: Spec step 6 (Documentation) is not in the diff: neither app_docs/storage.md nor app_docs/studio.md changed. storage.md is missing the Scratch cleanup bullet for prepareScratchDir and its exit line, the Configuration note that WORKER_SCRATCH_DIR is created when missing, the Testing mention of the new cases, and the new Rules line (never read the scratch volume before creating the scratch folder). studio.md line 136 still says doctor 'checks Supabase, R2, ffmpeg and one structured claude -p call', now wrong: the r2 line was renamed to "r2 bucket readable and writable", there is a write probe, and there is an eighth scratch dir line. Resolution: edit the two docs as spec step 6 lays out. Use no em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-91-adw-fb57dacf-sdlc_planner-worker-scratch-dir-and-r2-write-probe.md`
**Issue:** The implementation (`prepareScratchDir`, `scratchDirState`, the `r2 bucket readable and writable` probe under `<R2_KEY_PREFIX>doctor/`, the `scratch dir` doctor line) landed without spec step 6. `app_docs/storage.md` does not describe creating the scratch folder, and `app_docs/studio.md`'s Worker section still describes the old doctor checks.
**Solution:** Edit only the two docs, in place, adding the facts spec step 6 lists. No code change, no new doc, no index change (both docs already have their line in `docs/conditional-docs.md`).

## Files to Modify

- `app_docs/storage.md`
- `app_docs/studio.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: `app_docs/storage.md`, "Scratch cleanup" and "Configuration"

- In "### Scratch cleanup", add a first bullet before the `withJobScratch` one:
  ``- `prepareScratchDir` (`apps/worker/src/scratch.ts`) creates `WORKER_SCRATCH_DIR` with its parents at `worker`, `worker:prod` and `once` start-up, before the first heartbeat or claim, so the disk guard can read its volume. When it cannot, the worker prints `worker: scratch folder <dir> cannot be created: <reason>` and exits 1.``
- In "## Configuration", extend the `WORKER_SCRATCH_DIR` bullet: `(default the OS temp folder): where job folders live and whose volume the guard reads; created with its parents at start-up when missing.`

### Step 2: `app_docs/storage.md`, "Testing" and "Rules"

- In "## Testing", after the unit file list, add a sentence naming the new cases: `scratch.test.ts` covers `prepareScratchDir` creating a missing nested folder and leaving an existing one, and `scratchDirState` reporting an existing folder, a missing one under a writable parent without creating it, and refusing a regular file at the path or as a parent; `doctor-checks.test.ts` covers the `r2 bucket readable and writable` probe (all lines pass and no probe is left, failures naming the put for a read-only key, the get for a missing or different read-back, still deleting it, and the delete) and the `scratch dir` line.
- In "## Rules", add: `- Never read the scratch volume before creating the scratch folder.`

### Step 3: `app_docs/studio.md`, "### Worker"

- Replace the parenthetical `` `doctor` (checks Supabase, R2, ffmpeg and one structured `claude -p` call) `` with: `` `doctor` (checks Supabase, R2 read and write access through a probe it puts, reads back and deletes under `<R2_KEY_PREFIX>doctor/`, the scratch folder, which must exist or be creatable and which it never creates, ffmpeg and one structured `claude -p` call) ``.
- After the "Each loads `.env.development` ..." sentence, add: `` `worker`, `worker:prod` and `once` create the scratch folder (`WORKER_SCRATCH_DIR`) at start-up and exit 1 when they cannot (see `app_docs/storage.md`). ``
- Reflow paragraphs to the docs' ~100-column wrap; no em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -n "—" app_docs/storage.md app_docs/studio.md` returns nothing (no em-dashes).
- `grep -n "prepareScratchDir\|cannot be created\|created with its parents\|Never read the scratch volume" app_docs/storage.md` shows each addition; `grep -n "doctor/\|readable\|scratch folder" app_docs/studio.md` shows the Worker section change.
- `yarn format:check`
- `yarn knip`
- `yarn turbo run test --filter=./apps/worker`

## Patch Scope

**Lines of code to change:** about 15 lines of Markdown across two docs
**Risk level:** low
**Testing required:** documentation only; format check and the worker unit suite to confirm nothing else moved
