# Patch: onset detection ignores codec residue, then record the green tools run

## Metadata

adw_id: `95bd0696`
review_change_request: `Issue #1: The validation command PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools exits 1, so the acceptance criterion 'On the Mac, the tools spec passes' fails. 'the sound matches the sound track' fails at preview-matches-export.spec.ts:351 with 'Error: onset at 1.830562 s outside every click' (loudness export -15.2 LUFS vs source -15.1 LUFS, click onset error 7.9 ms). 'the render step sampled the whole process group' does not run because the spec is serial, so render peak_rss_bytes is unverified and not recorded (spec Notes lines 723 to 724). Resolution: fix onsets in apps/studio/tools/media.ts so the codec residue at about -32 dB around 1.83 s is not an onset: (a) a silence threshold set from measured evidence, written in a comment, above the residue and well below the click's level, or (b) high-pass or gate the difference. Do not drop the 'no onset outside a hit window' assertion, do not loosen LOUDNESS_LU or ONSET_S. Run test:tools until all three tests pass, record every value from that one run (including peak_rss_bytes) in the spec's Notes 'Recorded values' bullet, and make app_docs/export.md's Testing paragraph quote the same numbers. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`

**Issue:** `onsets()` (`apps/studio/tools/media.ts:122`) subtracts the inverted source from the
export and reports every `silence_end` of `silencedetect=noise=-35dB:d=0.01`. AAC re-encoding
leaves a residue of the voice in that difference; at about 1.83 s it peaks near -32 dB, above the
-35 dB threshold, so it is reported as an onset outside every click window and the sound test
fails. The spec is serial, so the memory test never runs and `peak_rss_bytes` is never recorded.

**Solution:** Option (a): raise the threshold to `-22dB`, from measured evidence written in a
comment. Measured on this machine against `packages/edit/assets/sounds/mouse-click-trimmed.wav`,
taken to the difference's format (first channel, 48 kHz) with the preset's `gainDb: -13`: click peak
-12.1 dB, RMS peak -34.5 dB. Its first `silence_end` after 0.2 s of silence is 0.207896 s at -35 dB,
0.207937 s at -25 and -22 dB, and 0.207979 s at -20 dB. So the threshold moves the detected onset by
less than 0.1 ms, and the 7.9 ms error is the sample's own lead-in. -22 dB is 10 dB above the
residue's -32 dB and 10 dB below the click's -12 dB peak. Option (b) (a filter on the difference)
would change its spectrum and the click's onset with it, with no evidence to justify it, so it is
not taken. Both assertions and `LOUDNESS_LU` / `ONSET_S` stay as they are. Then one green
`test:tools` run supplies every recorded value, which also completes the `record-tools-values`
patch.

## Files to Modify

- `apps/studio/tools/media.ts`: the `silencedetect` threshold in `onsets()` and its comment.
- `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`: line 504 (the planned
  `-35dB`) and the Notes "Recorded values" bullet (lines 719 to 728).
- `app_docs/export.md`: the last sentence of the Tools bullet in `## Testing` (lines 146 to 148).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Raise the onset threshold with its evidence

- In `apps/studio/tools/media.ts`, add a named constant above `onsets()` and use it in the
  filter: `` `[export][inverted]amix=inputs=2:normalize=0,silencedetect=noise=${ONSET_NOISE_DB}dB:d=0.01` ``
  with `const ONSET_NOISE_DB = -22;`.
- Comment on the constant, in the file's style (no em-dashes): the AAC export does not cancel the
  source exactly, and its residue reached about -32 dB at 1.83 s, so -35 dB reported it as a click.
  The click (`mouse-click-trimmed.wav` at the preset's -13 dB) peaks at -12.1 dB in the difference.
  -22 dB sits 10 dB from each. Its detected onset moves by less than 0.1 ms between -35 and -20 dB
  (0.207896 s against 0.207979 s after 0.2 s of silence), so `ONSET_S` measures the same thing.
- Change nothing else: `SAME_FORMAT`, the inversion, `d=0.01`, the spec's assertions and constants
  stay.
- If the green run in Step 2 still reports an onset outside a window, do not lower the bar. Measure
  that onset's peak level in the difference (temporarily skip the `rm` in `afterAll`, then
  `ffmpeg -i <work>/export.mp4 -i fixtures/pipeline/retime/source.mp4 -filter_complex "[0:a]<SAME_FORMAT>[e];[1:a]<SAME_FORMAT>,volume=-1[i];[e][i]amix=inputs=2:normalize=0,atrim=<at-0.05>:<at+0.05>,astats" -f null -`,
  then restore the `rm`). Set the threshold between that peak and -12.1 dB only if there is still a
  margin of 6 dB or more on each side, and update the comment's numbers. Otherwise stop and report.

### Step 2: Run the tools spec once until all three tests pass, keeping its output

- The run's dev server must already be up on this run's port (`/prepare_app`, the Workspaces dev
  command). Never start the worker; only the spec spawns `once`.
- `mkdir -p agents/95bd0696/patch_agent && set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools 2>&1 | tee agents/95bd0696/patch_agent/tools.log`
- The run must report 3 passed, 0 failed, 0 skipped. From that log, read the spec's `console.log`
  lines: the matching whole and region SSIM, the probed caption id and its whole and region SSIM,
  `loudness: export ... LUFS, source ... LUFS`, `click onset errors (ms): ...` and
  `render step: ..., peak_rss_bytes ...`. Every value recorded below comes from this one run.

### Step 3: Record the run in the spec

- Line 504: replace `silencedetect=noise=-35dB:d=0.01` with `silencedetect=noise=-22dB:d=0.01`
  and add, in the same sentence, that the threshold sits between the AAC residue (about -32 dB)
  and the click's peak (-12.1 dB).
- Replace the Notes "Recorded values" bullet (from `- Recorded values (patch
\`frame-exact-caption-region\`)`to the end of the Notes) with values from Step 2's log only,
wrapped at 100 columns:`- Recorded values (tools run after patch \`onset-residue-threshold\`, all three tests passed): SSIM at 0.5 / 1.5 / 2.5 s, whole a / b / c, caption region d / e / f (bound 0.92); negative proof \`<caption id>\` moved 60 px, whole ..., region ..., lowest x; loudness export y LUFS, source z LUFS (dual mono); click onset errors (ms) e1, ...; render step \`peak_rss_bytes\` N (about M MiB, above one Chrome process's 256 MiB).`Then add one sentence: the onset threshold is -22 dB because the AAC residue (about -32 dB at
1.83 s) crossed the planned -35 dB. Keep the existing cause sentences (the 683 CSS px screenshot
squeezed into the frame and the upscaled export, the 1 to 1.5 px glyph offset, the old 2.9 LU
gap). Drop the sentence saying the onset check fails and`peak_rss_bytes` is not recorded.
- Four decimals for SSIM, one for LUFS and ms, `peak_rss_bytes` as the exact integer logged.

### Step 4: Make the export doc quote the same run

- In `app_docs/export.md`, Tools bullet of `## Testing`, replace "The matching scores were whole
  0.9926 / 0.9930 / 0.9949 and caption region 0.9478 / 0.9690 / 0.9305, the probe's lowest 0.6853;
  the rest of the values are recorded in the spec's Notes." with the Step 2 numbers: "The matching
  scores were whole a / b / c and caption region d / e / f, the probe's lowest x; loudness was
  export y LUFS against source z LUFS, click onset errors e1 ms, and the render step's
  `peak_rss_bytes` N; the same run is recorded in the spec's Notes."
- In the same bullet, after "clicks within 20 ms", add "(onsets found where the export minus the
  source rises above -22 dB, above the AAC residue)". If the run's region scores fall outside "0.93
  to 0.97", widen that range to the run's values. Change nothing else; the Rules stay as they are.
- Cross-check: every number in the doc's sentence appears in the Notes bullet, and every number in
  the Notes bullet appears in `agents/95bd0696/patch_agent/tools.log`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`: 3 passed (Step 2's run; it supplies the recorded values).
- `yarn format:check`: formatting of the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage` and `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: the changed tool file lints and typechecks.
- `yarn knip`: no unused export (the new constant stays module-local).
- `git diff --name-only origin/develop | xargs perl -ne 'print "$ARGV:$.\n" if /\x{2014}/; close ARGV if eof' -CSD`: prints nothing.

## Patch Scope

**Lines of code to change:** about 10 lines of TypeScript (one constant, its comment, the filter),
about 20 lines of Markdown (spec line 504 and Notes, the export doc's Testing bullet).
**Risk level:** low
**Testing required:** one full passing `test:tools` run on the Mac (guardrail, sound, memory),
whose logged values are the ones recorded; format check, lint, typecheck and knip.
