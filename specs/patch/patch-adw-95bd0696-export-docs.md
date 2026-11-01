# Patch: Write the export doc, its index line, and update the measurement, studio and pipeline docs

## Metadata

adw_id: `95bd0696`
review_change_request: `Issue #2: Step 14 (Documentation) is mostly not implemented, so the acceptance criterion "app_docs/export.md exists with its Rules, and docs/conditional-docs.md has its line" fails. Of the step's six items, only the app_docs/change-requests.md rule change landed. Missing: (a) app_docs/export.md does not exist; (b) docs/conditional-docs.md has no line for it; (c) app_docs/measurement.md:94 still lists studio_export_requested and studio_export_downloaded as "reserved, not sent yet", although ExportPanel.tsx now sends both, and it does not say the render step uses group memory sampling; (d) app_docs/studio.md does not mention the render kind, jobs.version_id, the exports table or the new specs; (e) app_docs/pipeline.md does not describe runPipeline's moveReelStatus option or the render's rebuild of rebuildable inputs. The previous slice (patch patch-adw-7812d494-change-requests-docs-and-profile.md) recorded that the document phase writes only one feature doc and its index line, so it will not do (c) to (e). Resolution: Write every item on this branch, with no code changes. Create app_docs/export.md with the sections the spec names (Overview, How it works with Database, Worker and Studio; How to Use; Configuration; Testing; Rules; Notes), covering the render flags and why each, the sound handling, the R2 key and 24-hour expiry, the download link signing, the guardrail and its recorded scores (from issue 1), the two events and the GSAP CDN. Include the Rules listed in step 14. Add its one line to docs/conditional-docs.md with the wording the spec gives. Mark both export events as sent in app_docs/measurement.md and note the render step's group memory sampling. Add the render kind, jobs.version_id, exports and the new specs to app_docs/studio.md. Add moveReelStatus and the render rebuild to app_docs/pipeline.md. Then rerun the em-dash check from Validation Commands. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`
**Issue:** Step 14 of the spec was skipped except for the `app_docs/change-requests.md` rule. There
is no `app_docs/export.md` and no index line; `app_docs/measurement.md` calls both export events
reserved; `app_docs/studio.md` describes `jobs` without the `render` kind, `version_id` or the
`exports` table, its Rules still cap the `jobs` insert grant at `restore_version_id`, and its
Testing section omits the new specs; `app_docs/pipeline.md` says nothing about `moveReelStatus` or
the render's rebuild.
**Solution:** Documentation only, no code, test, migration or fixture change. Write all five items
on this branch (the document phase writes one feature doc and its index line only). Every fact
below was read from the current source; re-read the named file while writing so each literal
(identifier, message, flag, path) is exact.

## Files to Modify

- `app_docs/export.md` (new)
- `docs/conditional-docs.md` (one new line, last)
- `app_docs/measurement.md` (events table; How to Use step 1 or the step runner text)
- `app_docs/studio.md` (Jobs, steps and the lease; Testing; Rules)
- `app_docs/pipeline.md` (How it works)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Write `app_docs/export.md`

Title `# Export: render job, 24-hour download link, preview-matches-export guardrail`, then
`**Specifications:** [specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md](../specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md)`
(same form as the top of `app_docs/change-requests.md`), then `## Overview`, `## How it works`
(subsections `### Database`, `### Worker`, `### Studio`), `## How to Use`, `## Configuration`,
`## Testing`, `## Rules`, `## Notes`. Content:

- Overview: the owner presses Export on a processed reel's page; the studio inserts a `render` job
  pinned to the current version (`jobs.version_id`) and sends `studio_export_requested`; the worker
  makes sure the version's full-size inputs exist, builds the page with the same `build()` the
  preview uses, renders it with HyperFrames, uploads the MP4 and records an `exports` row that
  expires 24 hours after it is made; the page shows the newest export's download link without a
  reload, then "expired, export again".
- Database (`supabase/migrations/20261108090000_exports.sql`): `jobs_kind_check` adds `render`;
  `jobs.version_id` with `jobs_version_check` (a version exactly when `kind = 'render'`); the insert
  grant `(reel_id, kind, request, restore_version_id, version_id)`; `reel_has_active_job` now ignores
  render jobs (the interim ordering rule covers changes and restores only); new security definer
  `reel_has_active_render(p_reel_id, p_version_id)` (execute revoked from `public`, `anon`,
  `service_role`, granted to `authenticated`); policy "jobs: owner queues a render of a version of
  own processed reel" (one active render per version); table `exports` (`id`, `reel_id`, `owner_id`,
  `job_id`, `version_id`, `r2_key`, `bytes > 0`, `created_at`, `expires_at`), index
  `exports_reel_idx`, trigger `exports_set_expiry` setting `expires_at = created_at + interval '24
hours'` (a trigger since a generated column cannot use `timestamptz + interval`); RLS with owner
  `select` only (all revoked from `anon` and `authenticated`, `select` granted back), in the
  `supabase_realtime` publication. Only the worker writes `exports`.
- Worker:
  - `apps/worker/src/process-job.ts` routes `render` to `steps/render.ts`.
  - `steps/render-inputs.ts` (`ensureRenderInputs`): the two media inputs (retimed `source.mp4`,
    cut-out `subject.webm`) are `rebuildable`; both stored, nothing runs; either missing, the fixed
    pipeline rebuilds them through `runPipeline({ moveReelStatus: false })` before the render step
    row, so the rebuild writes its own step rows first and `reels.status` never moves.
  - `steps/render-project.ts` (`writeRenderProject`): a temporary HyperFrames project in the scratch
    folder (the built page, full-size media, the preset's fonts and click sounds). The built page is
    never stored.
  - `steps/render-args.ts`: the exact command
    `hyperframes render <project> -o <tmp>.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr --no-best-effort --quiet`
    with `HYPERFRAMES_NO_TELEMETRY=1`, and why each flag (copy the reasons from the comment over
    `RENDER_FLAGS`: delivery for platform recompression, three software workers faster than GPU with
    one and identical on a GPU-less cloud machine, SDR like the preview and the platforms, no best
    effort so a missing font or unready video fails instead of exporting a wrong frame, quiet so
    the log keeps errors). `--start`/`--end` exist for the tools test only; no job carries a range.
    `exportKey`: `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4`.
  - `steps/render.ts`: runs through the step runner with `sampleGroupMemory: true`; uploads; inserts
    the row through `export-store.ts` (`expires_at` comes back from the database, never computed by
    the worker); step line `render: exported, <duration>, <size>`. A render never moves
    `reels.status` or `current_version_id` (`finishJob`/`failJob` pass `null` for it).
  - Sound: clicks stay as the page's `<audio>` elements from the sound track; HyperFrames 0.8.222
    `mixAudioTracksFlat` mixes them with the footage's sound (`amix ... normalize=0`, audio gain 1,
    `PRODUCER_AUDIO_GAIN` never set), so no ffmpeg remix and the voice keeps its level; cite the
    measured loudness from the spec's Notes.
  - `fake-render.ts`: `E2E_MOCK_RENDER=true` (exactly) copies `fixtures/export/render.mp4` instead of
    rendering; a rebuild still runs the real tools.
- Studio: `src/lib/exports.ts` (`EXPORT_COLUMNS`, `latestExport`, `exportView`,
  `exportBlockedReason` with its messages "Export opens once processing has finished.", "No version
  to export yet.", "Exporting this version.", `DOWNLOAD_URL_MAX_SECONDS = 3600`, `downloadSeconds`
  (the time left, capped at one hour, null once expired), `exportFileName` giving
  `reel-<first 8 of reel id>-<yyyymmdd-hhmm UTC>.mp4`, `signExportDownload`);
  `src/app/export-actions.ts` (`requestExport`, `exportDownloadUrl`: never signs past `expires_at`);
  `packages/storage` `signDownload(key, { expiresInSeconds, fileName })` with
  `isDownloadName`/`attachmentDisposition` serving it as an attachment; `src/components/ExportPanel.tsx`
  (the button, "Queued: waiting for the worker", the refused message, the link with its "until"
  time, one timeout flips it to "expired, export again", no polling; sends both events with
  `reel_id`); `LiveReel.tsx` reads and subscribes to `exports` through Realtime.
- How to Use: press Export on a processed reel, wait for the `render` step line, click the link
  within 24 hours; export again after it expires.
- Configuration: the worker's existing R2 and Supabase variables and `R2_KEY_PREFIX`; no new
  variable except `E2E_MOCK_RENDER` (set by `export.spec.ts` only). The owner's R2 lifecycle rule
  deletes `<prefix>exports/` after 1 day (whole days, a backstop; `expires_at` is the real limit).
  The render needs network: the built page loads GSAP `gsap@3.14.2` from `cdn.jsdelivr.net` (the
  preset names it).
- Testing: unit (`apps/studio/src/lib/exports.test.ts`, `apps/worker/src/steps/render*.test.ts`,
  `fake-render.test.ts`, `run-pipeline.test.ts`, storage tests); DB (`apps/studio/db-tests/exports.test.ts`,
  the `realtime.test.ts` addition); E2E `apps/studio/e2e/export.spec.ts` (mock render); tools
  `apps/studio/tools/preview-matches-export.spec.ts` (Mac only, real HyperFrames): SSIM >= 0.95 on
  the whole frame and on the probed caption's region at 0.5, 1.5 and 2.5 s, the 60 px negative
  proof (served through `page.route`, nothing stored) below the bound on the lowest score, loudness
  within 0.5 LU, clicks within 20 ms, render `peak_rss_bytes` above one Chrome process. Copy the
  recorded values from the spec's Notes "Recorded values" line (filled by the issue 1 patch,
  `specs/patch/patch-adw-95bd0696-caption-region-ssim-guardrail.md`); if that line is still empty,
  write the matching whole-frame scores already known (0.9922 / 0.9929 / 0.9959) and say the rest
  are recorded in the spec's Notes, never invent a number.
- Rules (verbatim intent from step 14): render only on export, never for the preview; software
  mode with three workers at delivery quality, never a GPU mode; the same builder, the worker never
  edits the built page; never store the built page; never sign a link past `expires_at`; a render
  never moves `reels.status` or `current_version_id`; never hard-code a sound. Add: do not grant
  the owner any write on `exports`.
- Notes: the negative proof without a stored version (a probe version would rewrite history); range
  flags kept for a future partial render; GSAP vendoring out of scope; owner steps (lifecycle rule,
  hosted migration); out of scope: render progress (slice 15), deleting rebuildable files (slice
  14), cloud rendering.

### Step 2: Add the index line to `docs/conditional-docs.md`

Append, after the `change-requests.md` line, exactly:
``- `app_docs/export.md`: read when changing the Export button, the `render` job kind or `jobs.version_id`, the render step or its HyperFrames flags, the `exports` table, its expiry or the download link, `E2E_MOCK_RENDER`, the export guardrail tools test, or `studio_export_requested` and `studio_export_downloaded`.``

### Step 3: Update `app_docs/measurement.md`

- Replace the row `` `studio_export_requested`, `studio_export_downloaded` | reserved, not sent yet ``
  with two rows: `studio_export_requested`, "an export is queued (`ExportPanel.tsx`, after a
  `queued` answer)"; `studio_export_downloaded`, "the download link is clicked (`ExportPanel.tsx`)";
  both `reel_id`, `app`. Re-read `ExportPanel.tsx` for the exact trigger. Keep the table aligned
  (Prettier).
- Where the doc describes `sampleGroupMemory: true` (How to Use step 1, and the step runner text if
  it lists which steps use it), add that the `render` step uses it (HyperFrames spawns Chrome
  processes), see `app_docs/export.md`.

### Step 4: Update `app_docs/studio.md`

- Jobs, steps and the lease: line 86, kinds become "`process`, later also `change`, `restore` and
  `render`"; add a bullet after the change-requests migration bullet:
  `supabase/migrations/20261108090000_exports.sql` adds the `render` kind, `jobs.version_id` with
  its check, the insert grant `(reel_id, kind, request, restore_version_id, version_id)`, the owner
  render policy (one active render per version through `reel_has_active_render`) and the `exports`
  table (owner `select` only, in Realtime, `expires_at` set by trigger); see `app_docs/export.md`.
- Testing: DB list adds `exports.test.ts` and Realtime for `exports`; E2E list adds `export` (`export.spec.ts` spawns `once`
  with `E2E_MOCK_RENDER=true`); add a tools line for `apps/studio/tools/preview-matches-export.spec.ts`
  (`yarn workspace @edit-issebya/studio test:tools`, Mac only).
- Rules: the `jobs` insert grant rule becomes "beyond `reel_id`, `kind`, `request`,
  `restore_version_id` and `version_id`" (same change as `change-requests.md`, so the two docs agree);
  add "Do not grant `authenticated` or `anon` any write on `exports`; only the worker inserts it."

### Step 5: Update `app_docs/pipeline.md`, then check

- In How it works, add a bullet for `apps/worker/src/pipeline/run-pipeline.ts`: `runPipeline` takes
  `moveReelStatus` (default `true`); the render passes `false` when its `rebuildable` inputs
  (`source.mp4`, `subject.webm`) are missing, so the fixed steps rebuild them (cache hits for every
  stored output) without writing `reels.status`; see `app_docs/export.md`. Mention it next to the
  `rebuildable` tag text (line 26) as the first reader of that tag.
- Run `yarn format` on the changed docs if Prettier rewraps, then the validation below.

## Validation

- `yarn format:check`
- `git diff --name-only origin/develop | xargs perl -ne 'print "$ARGV:$.\n" if /\x{2014}/; close ARGV if eof' -CSD` (must print nothing; also run it over the untracked `app_docs/export.md` with `perl -ne 'print "$ARGV:$.\n" if /\x{2014}/' -CSD app_docs/export.md`)
- `grep -n "export.md" docs/conditional-docs.md` (exactly one line) and `grep -n "reserved, not sent yet" app_docs/measurement.md` (no export event left on it)
- `git diff --stat -- apps packages supabase fixtures` shows nothing from this patch (docs only)

## Patch Scope

**Lines of code to change:** about 170 lines of Markdown (export doc about 130, the other four about 40), no code
**Risk level:** low
**Testing required:** format check and the em-dash check; no code changed, so no unit, DB or E2E rerun is needed for this patch
