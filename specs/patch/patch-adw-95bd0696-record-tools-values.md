# Patch: record the passing tools run's values in the spec's Notes and the export doc

## Metadata

adw_id: `95bd0696`
review_change_request: `Issue #2: Step 12 and the acceptance criterion require the measured values to be recorded in the spec's Notes. Line 719 of specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md still reads 'Recorded values (fill in at step 12)' with no values. app_docs/export.md:141 says 'the rest of the values are recorded in the spec's Notes', which is currently false, and the whole-frame scores it quotes (0.9922 / 0.9929 / 0.9959) come from the run before the patch. Resolution: After issue 1 passes, fill in the Notes 'Recorded values' line with the measured values: whole and region SSIM at 0.5, 1.5 and 2.5 s; the negative proof's lowest score; export and source loudness in LUFS; onset errors in ms; and the render step's peak_rss_bytes. Then update the Testing paragraph in app_docs/export.md so the scores it quotes match that run. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`

**Issue:** The Notes "Recorded values" bullet (spec line 719) is incomplete: the working tree holds
values from the `frame-exact-caption-region` run, but that run still failed the onset check (codec
residue at 1.83 s), so the serial spec never reached the memory test and `peak_rss_bytes` is
missing; the bullet says so instead of recording it. The spec's acceptance criterion ("the values
are recorded in this spec's Notes") is therefore unmet. `app_docs/export.md`'s Testing paragraph
(lines 137 to 141) quotes scores and claims "the rest of the values are recorded in the spec's
Notes", which is not yet true, and its scores must come from the same run the Notes record.

**Solution:** Docs only, no code. Once issue 1's fix makes `test:tools` pass end to end (all three
tests green: guardrail, sound, memory), run it once on the Mac with its output saved, then rewrite
the Notes bullet with every value from that one run (whole and region SSIM at 0.5 / 1.5 / 2.5 s,
the probed caption and the negative proof's lowest score, export and source LUFS, every onset error
in ms, the render step's `peak_rss_bytes`), and make the export doc's Testing paragraph quote the
same numbers. If the run does not pass, stop: issue 1 is not resolved and no value is recorded.

## Files to Modify

- `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`: the Notes
  "Recorded values" bullet only (currently lines 719 to 728).
- `app_docs/export.md`: the last sentences of the Tools bullet in `## Testing` (lines 137 to 141,
  "The matching scores were ... recorded in the spec's Notes.").

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Run the tools spec once and keep its output

- Precondition: issue 1's patch is applied (`apps/studio/tools/preview-matches-export.spec.ts` and
  `apps/studio/tools/media.ts` as in the working tree, plus any onset fix issue 1 still needs) and
  the run's dev server is up on this run's port (`/prepare_app`, the Workspaces dev command). Never
  start the worker; only the spec spawns `once`.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools 2>&1 | tee agents/95bd0696/patch_agent/tools.log`
- It must report 3 passed, 0 failed, 0 skipped. If anything fails or is skipped, stop and report:
  issue 1 is unresolved, and this patch records nothing from a failing run.
- From `agents/95bd0696/patch_agent/tools.log` read the spec's `console.log` lines (lines 309, 329,
  344, 349 and 373 of the spec): the matching whole and region SSIM lists, the probed caption id
  and its whole and region lists, `loudness: export ... LUFS, source ... LUFS`,
  `click onset errors (ms): ...`, and `render step: ..., peak_rss_bytes ...`.

### Step 2: Rewrite the spec's Notes "Recorded values" bullet

- Replace the whole bullet (from `- Recorded values (patch \`frame-exact-caption-region\`)`to the
end of the Notes) with values from Step 1's run only, in this shape, wrapped at 100 columns like
the rest of the Notes:`- Recorded values (tools run after patch \`<issue 1 patch slug>\`, all three tests passed): SSIM at 0.5 / 1.5 / 2.5 s, whole a / b / c, caption region d / e / f (bound 0.92); negative proof \`<caption id>\` moved 60 px, whole ... , region ... , lowest x; loudness export y LUFS, source z LUFS (dual mono); click onset errors (ms) e1, e2, ...; render step \`peak_rss_bytes\` N (about M MB, above one Chrome process).`
- Keep the two cause sentences already there (the old region scores came from the 683 CSS px
  screenshot squeezed into the frame and the upscaled export; the old 2.9 LU gap was the mono source
  against the stereo export and `amix` ignoring the negative weight), since they explain the
  numbers. Drop the sentence saying the onset check fails and `peak_rss_bytes` is not recorded.
- Four decimals for SSIM, one for LUFS and ms, `peak_rss_bytes` as the exact integer the log prints.
- No em-dashes; touch no other line of the spec.

### Step 3: Make the export doc's Testing paragraph match that run

- In `app_docs/export.md`, Tools bullet of `## Testing`, replace
  "The matching scores were whole 0.9926 / 0.9930 / 0.9949 and caption region 0.9478 / 0.9690 /
  0.9305, the probe's lowest 0.6853; the rest of the values are recorded in the spec's Notes." with
  the same run's numbers: "The matching scores were whole a / b / c and caption region d / e / f,
  the probe's lowest x; loudness, onset errors and `peak_rss_bytes` of the same run are recorded in
  the spec's Notes."
- Check the paragraph's "a caption region alone scores 0.93 to 0.97" against the run's region
  scores; if the run's lowest or highest region score falls outside that range, widen the range to
  the run's values (two decimals). Change nothing else in the doc (its Rules stay as they are).

### Step 4: Cross-check

- Every number in the doc's sentence appears verbatim in the Notes bullet, and every number in the
  Notes bullet appears in `agents/95bd0696/patch_agent/tools.log`.
- `grep -n "fill in at step 12\|not yet recorded" specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md app_docs/export.md` prints nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`: 3 passed (Step 1's run; the values recorded come from it).
- `yarn format:check`: the two edited Markdown files are Prettier-clean (run `yarn format` on them if not).
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage` and `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: unchanged code still passes (the commit hook runs them).
- `yarn knip`: still clean.
- `git diff --name-only origin/develop | xargs perl -ne 'print "$ARGV:$.\n" if /\x{2014}/; close ARGV if eof' -CSD`: prints nothing.

## Patch Scope

**Lines of code to change:** about 15 lines of Markdown (10 in the spec's Notes, 5 in `app_docs/export.md`), no code.
**Risk level:** low
**Testing required:** one full passing `test:tools` run on the Mac, whose logged values are the ones recorded; format check and the commit hook's lint, typecheck and knip.
