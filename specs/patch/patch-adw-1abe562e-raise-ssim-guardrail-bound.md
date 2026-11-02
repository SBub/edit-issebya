# Patch: Raise the preview-export SSIM bound to 0.99 with recorded evidence

## Metadata

adw_id: `1abe562e`
review_change_request: `Issue #1: Spec Validation Command PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools exits 1. Test 1 (positive guardrail) passes with SSIM 0.5 s 0.995673, 1.5 s 0.995609, 2.5 s 0.997499 (render peak_rss_bytes 1583153152). Test 2, 'a caption moved by 60 px falls below the bound', fails: the probe scores 0.995673, 0.982028 and 0.994654, so the minimum 0.982028 is not below PREVIEW_EXPORT_SSIM_BOUND = 0.95 (apps/studio/e2e-tools/export-matches-preview.spec.ts:26, assertion at :314). The acceptance criterion 'the 60 px probe scores at least one frame below it' does not hold. Spec step 17 says what to do in this case and it was not done: raise the bound between the two score sets (never below 0.9) and record the evidence in app_docs/export.md. Resolution: In apps/studio/e2e-tools/export-matches-preview.spec.ts, raise PREVIEW_EXPORT_SSIM_BOUND to a value between the probe minimum (0.982028) and the positive minimum (0.995609), for example 0.99, with a comment citing both score sets. Update the bound in the acceptance wording of app_docs/export.md and record the measured positive and negative scores there. Re-run the studio test:tools command and confirm both tests pass. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-1abe562e-sdlc_planner-export-render-job.md`
**Issue:** The studio tools suite fails its negative proof. The guardrail scores 0.995673, 0.995609 and 0.997499 (minimum 0.995609); the 60 px probe scores 0.995673, 0.982028 and 0.994654 (minimum 0.982028). With `PREVIEW_EXPORT_SSIM_BOUND = 0.95` the probe never falls below the bound, so the comparison is not proven sensitive. Spec step 17 requires raising the bound between the two score sets (never below 0.9) and recording the evidence in `app_docs/export.md`, which was not done (the doc does not exist yet).
**Solution:** Set `PREVIEW_EXPORT_SSIM_BOUND` to `0.99` (above the probe minimum 0.982028 by 0.008, below the guardrail minimum 0.995609 by 0.0056), with a comment citing both measured score sets. Create `app_docs/export.md` with the guardrail section (the bound, why it was raised from 0.95, both score sets and the render's `peak_rss_bytes`), so the document phase later extends the same file in place (step 19), and add its one line to `docs/conditional-docs.md`. Re-run the studio `test:tools` command and confirm both tests pass.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/e2e-tools/export-matches-preview.spec.ts` (the bound constant at line 26 and its comment, lines 21 to 26)
- `app_docs/export.md` (new: the guardrail bound and the measured scores)
- `docs/conditional-docs.md` (one line for `app_docs/export.md`)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Raise the bound in the guardrail spec

- In `apps/studio/e2e-tools/export-matches-preview.spec.ts`, change `const PREVIEW_EXPORT_SSIM_BOUND = 0.95;` to `0.99`.
- Extend the comment above it (keep the existing guardrail explanation) with the evidence, no em-dashes, for example:
  `// The bound started at 0.95 and was raised with measured evidence (never below 0.9): the guardrail`
  `// scored 0.995673, 0.995609 and 0.997499 at 0.5, 1.5 and 2.5 s; the 60 px probe scored 0.995673,`
  `// 0.982028 and 0.994654. 0.99 sits between the probe minimum and the guardrail minimum.`
- Change nothing else: the assertions at lines 274 and 314, `MOMENTS`, `PROBE_SHIFT_PX` and the test names stay as they are. Never lower the shift or loosen an assertion to pass.

### Step 2: Record the bound and the evidence in `app_docs/export.md`

- Create `app_docs/export.md` with a title (`# Export`), a short Overview (the Export button renders the current version to an MP4 through a `render` job; the owner downloads it through a 24-hour link) and a `## Testing` section containing a `### Preview matches export guardrail` subsection that states:
  - The command: `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools` (the owner's Mac only, against the run's servers, never in CI).
  - The acceptance wording with the new bound: every guardrail frame scores at or above `PREVIEW_EXPORT_SSIM_BOUND` (0.99) and the 60 px probe scores at least one frame below it.
  - That the bound was raised from 0.95 to 0.99 because the probe's minimum (0.982028) was above 0.95, and the bound must never go below 0.9.
  - A table of the measured scores: moment (0.5 s, 1.5 s, 2.5 s), guardrail (0.995673, 0.995609, 0.997499), probe (0.995673, 0.982028, 0.994654); and the render step's `peak_rss_bytes` 1583153152 (above 256 MB).
- Add a `## Rules` line: never lower `PREVIEW_EXPORT_SSIM_BOUND` below 0.9, and never change it without re-measuring both score sets and recording them here.
- No em-dashes. Leave the rest of the doc (How it works, Configuration, other rules) to the document phase, which updates this same file in place.

### Step 3: Index the doc

- Add one line to `docs/conditional-docs.md` for `app_docs/export.md`, in the file's existing format, for example: when working on the Export button, the `render` job, the `exports` table, download links or the preview-matches-export guardrail and its SSIM bound.

### Step 4: Re-run the tools suite

- Source `.ports.env` and run the studio tools command against the run's servers (the `/prepare_app` server must already be up on this run's port; never start, reuse or kill another server). Confirm both tests pass and that the logged scores still separate around 0.99. If a new run's guardrail minimum falls below 0.99 or the probe minimum rises above it, pick a bound between the newly measured sets (never below 0.9) and update the spec comment and the doc table with those numbers.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`: both the guardrail and the 60 px probe tests pass.
- `yarn format:check`: formatting over the whole repository (the new doc and the spec).
- `yarn turbo run lint --filter=./apps/studio`: lint the studio.
- `yarn turbo run typecheck --filter=./apps/studio`: studio types.
- `yarn knip`: no unused files or exports.

## Patch Scope

**Lines of code to change:** about 5 in the spec, about 40 in the new doc, 1 in the index
**Risk level:** low
**Testing required:** the studio `test:tools` suite on the owner's Mac (real HyperFrames render, both tests green), plus format, lint, typecheck and knip.
