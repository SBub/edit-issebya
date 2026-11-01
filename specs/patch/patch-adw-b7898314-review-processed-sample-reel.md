# Patch: Give the review user a processed sample reel with a live preview

## Metadata

adw_id: `b7898314`
review_change_request: `Issue #2: Visual evidence applied but the critical path could not be captured. The review user (studio-review@example.test, made by e2e:sign-in-url) has only a received and an uploaded sample reel, neither with a current version or preview copies, so the player, its controls and the 'Loading' hold are unreachable from the browser. Making a processed reel would mean running the worker (forbidden by Protected) or seeding the database by hand (forbidden in review). Only the waiting line ('The preview appears once processing has finished.') was captured, at both viewports. The criteria 'the reel page of a processed reel shows the player playing its current version' and 'visible Loading status' are therefore covered only by preview.spec.ts, not by visual review. Resolution: extend the studio's review sign-in helper (apps/studio/test-support, behind e2e:sign-in-url) to give the review user one processed sample reel: seed the committed fixtures/pipeline/ outputs into the mock storage with seedPipelineCache, save version 1 through saveVersion and supabaseVersionStore(admin), and set preview_copies_fingerprint and current_version_id with the secret key (test-support only, no worker run). Then name that reel's page in .adw/project.md Review so the next review can capture the player at 1920x1080 and 375x667. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-32-adw-b7898314-sdlc_planner-live-preview-hyperframes-player.md`
**Issue:** `apps/studio/scripts/e2e-sign-in-url.ts` only gives `studio-review@example.test` an `uploaded` and a `received` reel. Neither has a `current_version_id` or a `preview_copies_fingerprint`, so `previewSources` (`apps/studio/src/app/preview-actions.ts`) answers `no-version` and the reviewer can never see the player, its controls or the "Loading" hold.
**Solution:** Fixture change only, no feature code. Add one helper to `apps/studio/test-support/pipeline.ts` that makes a processed reel the way the worker would leave it, without spawning the worker: seed the committed step outputs with `seedPipelineCache`, save version 1 with `saveVersion` + `supabaseVersionStore(admin)` (which moves `current_version_id` through `save_version`), then set `preview_copies_fingerprint` and `status: "processed"` with the admin (secret key) client. Call it idempotently from `e2e-sign-in-url.ts`, and name the reel in the profile's Review section and in `app_docs/studio.md`.

Facts this plan relies on (read from the current source):

- `previewKeys` (`apps/studio/src/lib/preview-sources.ts`) derives the cache prefix from the version's `r2_key` (`<prefix>reels/<reel>/versions/<id>.json`), so the cache and the version must share one prefix. Use the fixed prefix `review/`.
- Under `E2E_MOCK_STORAGE=true` the studio reads `fakeStorage({ root: e2eStorageRoot(), uploadUrlBase: MOCK_UPLOAD_URL_BASE })` (`apps/studio/src/lib/storage.ts`); `e2eStorageRoot()` walks up to `turbo.json`, so the script (run by `yarn workspace` with cwd `apps/studio`) and the studio resolve the same worktree `.e2e-storage/`.
- The worker's version 1 (`apps/worker/src/steps/first-version.ts`) is `baselineEdit(transcript, { footage: retime, transcript: retime, cutout: remove_background, headTrack: head_track }, ISSEBYA)` with each value the step's fingerprint; the fingerprints are in `fixtures/pipeline/manifest.json` (`readManifest()` already reads it). The retimed transcript is `fixtures/pipeline/retime/transcript.json`.
- `.e2e-storage/` is per worktree but the Supabase stack is shared. A processed sample reel created from another worktree has its rows but no objects here, so the helper must check that the version object exists in this storage and, if not, delete that reel (versions cascade on reel delete, `20261104090000_versions.sql`) and make a new one. Never write or rewrite a version object by hand (Protected: never rewrite a saved version's object or row).

## Files to Modify

- `apps/studio/test-support/pipeline.ts` (new exported helper `seedProcessedReel`)
- `apps/studio/scripts/e2e-sign-in-url.ts` (call it for the review user)
- `.adw/project.md` (Review section, the Studio bullet only; the nine `##` headings untouched)
- `app_docs/studio.md` (step 7 of the local walk-through, one sentence)

Do not touch `apps/studio/src/`, the worker, `preview.spec.ts`, or any other uncommitted file from the earlier patches.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add `seedProcessedReel` to `apps/studio/test-support/pipeline.ts`

- Imports to add: `baselineEdit`, `ISSEBYA`, `type Transcript` from `@edit-issebya/edit` (next to the existing `saveVersion`, `supabaseVersionStore`).
- Signature: `export async function seedProcessedReel(admin: SupabaseClient, storage: Storage, { prefix, reelId }: { prefix: string; reelId: string }): Promise<VersionRow>`.
- Body, in order:
  1. `await seedPipelineCache(storage, prefix)` (overwrites cache objects only; never version objects).
  2. `const manifest = await readManifest()`; build `fingerprints` as `Object.fromEntries(manifest.steps.map((s) => [s.name, s.fingerprint]))`; throw if `retime`, `remove_background`, `head_track` or `preview_copies` is missing.
  3. Read `retime/transcript.json` from `PIPELINE_FIXTURES` (same `readFile` + eslint-disable comment as `readManifest`) and parse it as `Transcript`.
  4. `const edit = baselineEdit(transcript, { footage: retime, transcript: retime, cutout: removeBackground, headTrack }, ISSEBYA)`.
  5. `const row = await saveVersion({ objects: storage, store: supabaseVersionStore(admin), prefix, reelId, id: crypto.randomUUID(), edit, meta: { request: null, model: null, promptVersion: null, changeSummary: "review: sample first version", checks: { ok: true, reasons: [] } } })` (mirrors `saveNextVersion`; `save_version` sets `current_version_id`).
  6. `admin.from("reels").update({ status: "processed", preview_copies_fingerprint: fingerprints.preview_copies }).eq("id", reelId)`; throw `reel not updated: <message>` on error, as the spec does.
  7. Return `row`.
- Comment above it in the file's style: one or two lines saying it leaves a reel the way the worker's pipeline and `first_version` would (version 1, preview copies recorded) from the committed fixtures, with no worker run, for review (secret key, test helpers only).

### Step 2: Seed the processed sample in `apps/studio/scripts/e2e-sign-in-url.ts`

- Imports: `fakeStorage`, `e2eStorageRoot` from `@edit-issebya/storage`; `MOCK_UPLOAD_URL_BASE` is in `src/`, so pass `uploadUrlBase: ""` as `preview.spec.ts` does (the script never signs uploads); `seedProcessedReel` from `../test-support/pipeline.ts`.
- Constants: `const PROCESSED_NAME = "sample-processed-take.mp4"`, `const PREFIX = "review/"`, `const storage = fakeStorage({ root: e2eStorageRoot(), uploadUrlBase: "" })`.
- After the existing received-reel block and before the final `console.log`:
  1. Select the review user's reel with `source_name = PROCESSED_NAME` (`id, current_version_id`, `maybeSingle`), throwing on error.
  2. If found and it has a `current_version_id`, read that version's `r2_key` with the admin client and check `await storage.get(r2_key)`; if the object exists, reuse the reel (no writes besides nothing).
  3. Otherwise (no reel, no version, or the object missing in this worktree's storage): delete the stale reel if one was found (`admin.from("reels").delete().eq("id", id)`, throw on error), then `insertReel(admin, { ownerId, name: PROCESSED_NAME, status: "uploaded", createdAt: "2026-03-01T09:00:00Z" })` and `await seedProcessedReel(admin, storage, { prefix: PREFIX, reelId })`. The later `createdAt` puts it at the top of the list.
  4. Print the reel page on stderr so stdout stays exactly the sign-in URL: `console.error(\`processed sample reel: http://localhost:${PORT}/studio/reels/${id}\`)`.
- Update the header comment: the review user gets three sample reels, one processed with a live preview, seeded from `fixtures/pipeline/` into `.e2e-storage/` (needs the dev server's `E2E_MOCK_STORAGE=true`).

### Step 3: Name the reel in the profile and the studio doc

- `.adw/project.md`, Review, Studio bullet: replace "and a processed reel's page with the live preview player (seeded as `preview.spec.ts` seeds it)" with "and the `sample-processed-take.mp4` reel's page (its URL is printed on stderr by the sign-in command) with the live preview player, playing and after a seek showing the "Loading" hold"; replace "creates `studio-review@example.test` with two sample reels when missing" with "creates `studio-review@example.test` with an `uploaded` and a `received` sample reel when missing, and a processed one (version 1 and preview copies from `fixtures/pipeline/`, in this worktree's `.e2e-storage/`, no worker run) whenever this worktree's storage lacks it". Keep "each at 1920x1080 and 375x667".
- `app_docs/studio.md` step 7: append one sentence: it also gives the review user a processed sample reel (`sample-processed-take.mp4`) whose page shows the live preview, seeded from `fixtures/pipeline/` under `E2E_MOCK_STORAGE=true`.
- Run `grep -n "$(printf '\342\200\224')" .adw/project.md app_docs/studio.md apps/studio/test-support/pipeline.ts apps/studio/scripts/e2e-sign-in-url.ts specs/patch/patch-adw-b7898314-review-processed-sample-reel.md` and expect no output.

### Step 4: Prove it from the running app

- With the `/prepare_app` server up on this run's port (Workspaces dev command, which sets `E2E_MOCK_STORAGE=true`), run `set -a; . ./.ports.env; set +a; PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url` twice: the second run must print the same reel URL on stderr (idempotent) and stdout must be one line, the sign-in URL.
- Open the sign-in URL, then the printed reel page: the player is attached and "Play" becomes enabled; playing advances the time. This is a fixture check, not a new spec (no user-visible feature change).

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn turbo run lint --filter=./apps/studio`
- `yarn turbo run typecheck --filter=./apps/studio`
- `yarn knip`
- `yarn turbo run test --filter=./apps/studio`
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`

## Patch Scope

**Lines of code to change:** about 80 (40 in `pipeline.ts`, 35 in `e2e-sign-in-url.ts`, 5 in the two docs)
**Risk level:** low (test-support and the review script only; no app code, no migration)
**Testing required:** the studio's lint, typecheck, knip and unit tests; the E2E suites (unchanged, `preview.spec.ts` still passes since `saveNextVersion` and `seedPipelineCache` are untouched); a manual run of `e2e:sign-in-url` twice against the run's server showing the processed reel's player.
