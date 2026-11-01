# Patch: Write the export doc and bring the docs, profile and README in step (spec step 19)

## Metadata

adw_id: `1abe562e`
review_change_request: `Issue #2: Spec step 19 (Docs and profile) and the acceptance criterion 'docs and profile updated' are missing from the diff, which touches no file under app_docs/, docs/, .adw/ or README.md. There is no app_docs/export.md and no line for it in docs/conditional-docs.md. .adw/project.md does not mention export.spec.ts, E2E_MOCK_RENDER, the studio's test:tools or db-tests/exports.test.ts. app_docs/measurement.md:94 still lists studio_export_requested and studio_export_downloaded as 'reserved, not sent yet', but ExportPanel now sends both. app_docs/studio.md does not mention the render kind, the exports table or E2E_MOCK_RENDER. app_docs/pipeline.md does not mention setReelStatus. app_docs/change-requests.md does not mention that a render holds the one-job rule or the 'export of vN' label. README Checks lacks the two test:tools commands. Resolution: Do step 19 on this branch. Write app_docs/export.md with the sections and Rules the spec lists, including the stub's ffmpeg command and the measured guardrail scores, and add its line to docs/conditional-docs.md. Update app_docs/measurement.md (both export events sent from ExportPanel.tsx; the render is the step using sampleGroupMemory), app_docs/studio.md (four job kinds and the render policy, the exports table, E2E_MOCK_RENDER among the doubles), app_docs/pipeline.md (setReelStatus) and app_docs/change-requests.md (a render holds the one-job rule; the 'export of vN' label). In the .adw/project.md Tests section, add export.spec.ts, E2E_MOCK_RENDER, yarn workspace @edit-issebya/studio test:tools and db-tests/exports.test.ts, keeping the nine headings. Add both Mac-only test:tools commands to README Checks. No em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-1abe562e-sdlc_planner-export-render-job.md`
**Issue:** Step 19 was not done. The working tree already holds a partial `app_docs/export.md` (Overview, the guardrail subsection with the measured scores, one Rule, written by the SSIM-bound patch) and its index line in `docs/conditional-docs.md`, but the doc lacks How it works, How to Use, Configuration, the rest of Testing, the spec's Rules and Notes. `measurement.md`, `studio.md`, `pipeline.md`, `change-requests.md`, `.adw/project.md` and `README.md` say nothing about the export.
**Solution:** Complete `app_docs/export.md` in place (keep its guardrail subsection, scores table and bound rule exactly), keep the existing index line, and make the small targeted edits the spec's step 19 lists in the other five docs, the profile's Tests section and README Checks. Facts come from the code on this branch (`apps/worker/src/render/*.ts`, `apps/studio/src/lib/exports.ts`, `apps/studio/src/app/export-actions.ts`, `apps/studio/src/components/ExportPanel.tsx`, the `export_render_jobs` migration); verify each name before writing it. Documentation only, no code change.

## Files to Modify

- `app_docs/export.md` (complete the existing partial doc)
- `docs/conditional-docs.md` (the export line already exists in the working tree; keep it, add nothing)
- `app_docs/measurement.md` (events table row at line 94; the `sampleGroupMemory` mention)
- `app_docs/studio.md` (Jobs section around lines 85 to 96; Storage and AI doubles around lines 131 to 140; Configuration list of worker variables around line 171)
- `app_docs/pipeline.md` (How it works, where `runPipeline` and `reelStatus` are described)
- `app_docs/change-requests.md` (How it works near `jobRequestLabel` at line 29; Notes at line 77)
- `.adw/project.md` (Tests section only)
- `README.md` (Checks block)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Complete `app_docs/export.md`

- Read the current file first; keep `# Export`, the Overview, the whole `### Preview matches export guardrail` subsection (command, acceptance with 0.99, the 0.95 to 0.99 history, the scores table 0.995673 / 0.995609 / 0.997499 and 0.995673 / 0.982028 / 0.994654, `peak_rss_bytes` 1583153152) and the existing bound Rule verbatim.
- Add, in this order, the sections the other feature docs use (`## Overview`, `## How it works`, `## How to Use`, `## Configuration`, `## Testing`, `## Rules`, `## Notes`):
  - **How it works**: the migration (`supabase/migrations/<version>_export_render_jobs.sql`, use the real file name): `render` added to `jobs_kind_check`, `jobs.version_id` (a version of the same reel, required exactly for `render`), the `jobs: owner inserts a render job for own reel` policy, the `exports` table (columns, `expires_at = created_at + 24 hours` set by the `exports_before_insert` trigger, `owner_id` from the reel, `exports_refuse_update`, owner-only select RLS, in `supabase_realtime`, no insert policy: the worker writes with the secret key). The studio: `requestExport` inserts `{ reel_id, kind: "render", version_id: current_version_id }` (the browser never picks the version); `exportBlockedReason`'s three reasons. The worker: `job-kinds.ts` dispatches `render` with its `version_id`; `runRender` reuses an existing export of the job (a hit), runs the pipeline with `setReelStatus: false` so every step is a hit or the missing rebuildable one is rebuilt and the reel stays `processed`, reads the version's edit, transcript and head track, builds the page with `packages/edit`'s `build` (the same builder as the preview, never a worker copy, never stored), writes the project (`render-project.ts`) and runs one `render` step through the step runner with `sampleGroupMemory: true`. The exact command `hyperframes render <project> -o <tmp>/export.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr` with `HYPERFRAMES_NO_TELEMETRY=1` and no `PRODUCER_*` variable, and why (the `RENDER_SETTINGS` comment in `render-call.ts`: platforms recompress, software mode with three workers is faster than GPU with one and runs without a graphics chip; `--sdr`). Sound: only from the edit's sound track, inside the page; HyperFrames mixes at unity gain (evidence: the worker tools test's loudness within 0.5 LU of the source and clicks within 20 ms). Storage: `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4` (`export-key.ts`), `putFileIfAbsent`, the step line `render: exported, <duration>, <size>`. The download: `loadLatestExport` signs with `signDownload(key, { expiresInSeconds: exportLinkSeconds(...), downloadName: exportFileName(...) })` (`reel-v<N>-<YYYYMMDD-HHMM>.mp4`, UTC; `Content-Disposition: attachment`), never past `expires_at`; `ExportPanel.tsx` shows the link, `expires <time>`, and switches to `expired, export again` by one timeout; `LiveReel.tsx` follows `exports` INSERTs over Realtime. The render double: `E2E_MOCK_RENDER` exactly `"true"` makes the call `/bin/cp fixtures/render/stub-export.mp4 <output>`; the stub was made once with `ffmpeg -f lavfi -i color=c=black:s=108x192:r=30:d=1 -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -movflags +faststart fixtures/render/stub-export.mp4`.
  - **How to Use**: open a processed reel, press Export, wait for the step log's `render` line, click `Download version N (...)` within 24 hours; after that, export again.
  - **Configuration**: no new variable for production; `R2_KEY_PREFIX` decides the key; `E2E_MOCK_RENDER` (tests only, set by `apps/studio/test-support/worker.ts` for every spec; the tools spec passes it empty); `FFMPEG_PATH` honoured by `test-support/frames.ts`; the owner's R2 lifecycle rule deleting `<prefix>exports/` objects 1 day after creation (backstop, `expires_at` is what the owner sees).
  - **Testing**: before the existing guardrail subsection, list the unit tests (`render-call.test.ts`, `render-project.test.ts`, `export-key.test.ts`, `render-step.test.ts`, `job-kinds.test.ts`, `run-pipeline.test.ts`, `apps/studio/src/lib/exports.test.ts`, `change-requests.test.ts`, storage `r2.test.ts` / `fake.test.ts`, the mock `route.test.ts`), the DB test `apps/studio/db-tests/exports.test.ts`, the E2E `apps/studio/e2e/export.spec.ts` (stubbed render, download and expiry), and the worker tools test `yarn workspace @edit-issebya/worker test:tools` (`render.tools.test.ts`: loudness, click times, group memory; Mac only). Only list files that exist (check with `ls`).
  - **Rules** (add to the existing one): render only on export, never for the preview; software mode with three workers at `delivery` quality, never `--gpu` or `--browser-gpu`; the same builder, never a worker copy, never a stored page; never sign a link past `expires_at`; sounds only from the edit's sound track; never write an export row from the studio; never turn the render double on unless `E2E_MOCK_RENDER` is exactly `"true"`.
  - **Notes**: out of scope (render progress and time left, deleting rebuildable files and the disk guard, cloud rendering); the pipeline does not verify a full-length render on the worker machine, the platforms' recompression or the R2 lifecycle rule; the page loads GSAP from jsdelivr so a real render needs network; `--no-best-effort` considered, not added; owner steps (the R2 lifecycle rule for `dev/` and the production prefix, applying the migration to the hosted project after merge, the manual acceptance against `rethink-work-02.mp4` and a platform draft upload).
- Keep line width near 100 like the other docs. No em-dashes.

### Step 2: Update the four related feature docs

- `app_docs/measurement.md`: in the events table replace the `reserved, not sent yet` row with two rows: `studio_export_requested` (the Export button queues a render job, `ExportPanel.tsx`) and `studio_export_downloaded` (the owner clicks the download link, `ExportPanel.tsx`), both `reel_id`, `app`. Near the `sampleGroupMemory` description (line 33 or How to Use line 100) add that the export's `render` step is the step that uses it (HyperFrames runs Chrome workers and an encoder); see `app_docs/export.md`.
- `app_docs/studio.md`: in Jobs, steps and the lease, add a bullet for the `export_render_jobs` migration: four kinds (`process`, `change`, `restore`, `render`), `version_id` for a render, the third owner insert path `jobs: owner inserts a render job for own reel` (grant on `version_id`), and the `exports` table (owner-only select, written only by the worker, in `supabase_realtime`), pointing at `app_docs/export.md`. Adjust the "three kinds" wording so it stays true historically (that migration added three; the render migration adds the fourth). In Storage and AI doubles, add `E2E_MOCK_RENDER=true` (exactly) replaces the HyperFrames render with a copy of `fixtures/render/stub-export.mp4`; add `E2E_MOCK_RENDER` to the worker's tests-only variables in Configuration.
- `app_docs/pipeline.md`: in How it works, where `runPipeline` sets reel statuses, add that `PipelineRun.setReelStatus` (default `true`) set to `false` never calls `steps.reelStatus`; the export's `runRender` uses it so a render leaves the reel `processed`.
- `app_docs/change-requests.md`: next to `jobRequestLabel` (line 29) say a render job reads `export of vN` (`export` when the version is unknown); in Notes (line 77) add that the one-job-at-a-time rule counts every job, so a queued or running render also holds a change or going back, while the Export button follows only its own rule (`app_docs/export.md`).

### Step 3: Update `.adw/project.md` Tests section

- Only under `## Tests`; never rename or reorder the nine `##` headings.
- In the first paragraph, after the worker's `test:tools` clause, add the studio's: `yarn workspace @edit-issebya/studio test:tools` (`apps/studio/e2e-tools/export-matches-preview.spec.ts`, the preview-matches-export guardrail, real HyperFrames, on the owner's Mac only, never in CI, run as `PORT=<run port> STUDIO_PORT=<BACKEND_PORT>` against the run's servers from `/prepare_app`).
- In the DB layer list add `exports.test.ts` for the render job policy and the `exports` table (24-hour expiry, owner from the reel, never updated, owner-only select).
- In the studio E2E list, after `change-requests.spec.ts`, add `export.spec.ts` seeds a processed reel the same way, Export queues a `render` job the worker's `once` runs with the stubbed render (`E2E_MOCK_RENDER=true`, set by `test-support/worker.ts` for every spec, so no spec renders for real), the link downloads the stub, and a 25-hour-old export shows `expired, export again`.

### Step 4: Update README Checks

- In the `## Checks` bash block, after `yarn test:e2e`, add two lines with aligned comments:
  `yarn workspace @edit-issebya/worker test:tools   # real ffmpeg and HyperFrames, Mac only`
  `PORT=3000 STUDIO_PORT=3001 yarn workspace @edit-issebya/studio test:tools   # preview matches export, Mac only, needs the dev servers`
- No feature description beyond the one-line comments.

### Step 5: Check for em-dashes and formatting

- `grep -n $'\xe2\x80\x94' app_docs/*.md docs/conditional-docs.md .adw/project.md README.md` returns nothing.
- `yarn format` if `yarn format:check` complains (Prettier reflows Markdown tables).

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`: formatting over the whole repository, including the edited Markdown.
- `yarn knip`: no unused files (docs are not tracked, but the run's tree must stay clean).
- `grep -c "^## " .adw/project.md` prints 9, and `grep -n "^## " .adw/project.md` lists Identity, Workspaces, Install, Build, Tests, Ports, Protected, Documentation, Review in that order.
- `grep -n "reserved, not sent yet" app_docs/measurement.md` returns nothing; `grep -n "E2E_MOCK_RENDER" app_docs/studio.md app_docs/export.md .adw/project.md`, `grep -n "setReelStatus" app_docs/pipeline.md app_docs/export.md`, `grep -n "export of v" app_docs/change-requests.md` and `grep -n "test:tools" README.md` each find their lines.
- `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md README.md` returns nothing.

## Patch Scope

**Lines of code to change:** about 120 added to `app_docs/export.md`, about 25 across the four feature docs, about 10 in `.adw/project.md`, 2 in `README.md`
**Risk level:** low
**Testing required:** documentation only: format check, knip, the heading and grep checks above; no code or test changes.
