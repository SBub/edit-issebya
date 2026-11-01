# Patch: State the tool test clips and six cache hits in the ADW profile

## Metadata

adw_id: `a6bafcdf`
review_change_request: `Issue #1: Spec step 12 and its acceptance criterion require updating the .adw/project.md Tests section to say that test:tools also runs background removal, head tracking and preview copies on fixtures/footage/short-person.mp4, and that upload.spec.ts sees six hits. git diff 5e558e4 HEAD -- .adw is empty, and the profile still says the tool tests run 'on the committed clip'. AGENTS.md requires the profile to be kept in step. Resolution: edit the Tests section of .adw/project.md (do not rename or reorder its ## headings). Say that yarn workspace @edit-issebya/worker test:tools runs convert, transcribe and retime on fixtures/footage/short-speech.mp4, and runs background removal, head tracking and preview copies on fixtures/footage/short-person.mp4 (read-only). Say that upload.spec.ts expects six cache hits. Use no em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-30-adw-a6bafcdf-sdlc_planner-background-removal-head-tracking-previews.md`
**Issue:** Step 12 of the spec requires the profile's Tests section to describe the new tool tests on
`fixtures/footage/short-person.mp4` and the six cache hits of `upload.spec.ts`. The branch never
touched `.adw/project.md`: it still says the tool tests run "real ffmpeg and HyperFrames on the
committed clip" and that every step of `upload.spec.ts` is a cache hit, without a count. The
document phase writes only a feature doc and an index line, so it will not fix this.
**Solution:** Edit two sentences in the `## Tests` section of `.adw/project.md`, nothing else. The
clips match `apps/worker/src/pipeline/tools-test-support.ts` (`CLIP` is `short-speech.mp4`,
`PERSON_CLIP` is `short-person.mp4`).

## Files to Modify

- `.adw/project.md` (the `## Tests` section only)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Rewrite the tool tests clause in the Tests section's first paragraph

- Replace:
  `the tool tests \`yarn workspace @edit-issebya/worker test:tools\` (real ffmpeg and HyperFrames on the committed clip; on the owner's Mac only, never in CI);`
- With:
  `the tool tests \`yarn workspace @edit-issebya/worker test:tools\` (real ffmpeg and HyperFrames: convert, transcribe and retime on \`fixtures/footage/short-speech.mp4\`, background removal, head tracking and preview copies on \`fixtures/footage/short-person.mp4\`, which they only read; on the owner's Mac only, never in CI);`
- Re-wrap the paragraph to the surrounding line width (about 100 columns); keep every other command
  and its order unchanged.

### Step 2: State the six cache hits in the E2E paragraph

- Replace `spawns the worker's \`once\`, every step a cache hit,`with`spawns the worker's \`once\` and expects six cache hits (every step of the pipeline),`.
- Leave the rest of the paragraph (`step-log.spec.ts`, the run command, `PW_WEBKIT_WS`) as is.

### Step 3: Check the contract and style

- Do not rename, add, remove or reorder any `##` heading (still the nine: Identity, Workspaces,
  Install, Build, Tests, Ports, Protected, Documentation, Review).
- No em-dashes in the new text. Do not touch `fixtures/footage/short-person.mp4`.
- Run `yarn format` if `yarn format:check` flags the file.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -c '^## ' .adw/project.md` prints `9`, and `grep '^## ' .adw/project.md` lists Identity,
  Workspaces, Install, Build, Tests, Ports, Protected, Documentation, Review in that order.
- `grep -n 'short-speech.mp4' .adw/project.md && grep -n 'short-person.mp4' .adw/project.md && grep -n 'six cache hits' .adw/project.md`: all three match in the Tests section.
- `grep -rn $'\u2014' .adw` returns nothing: no em-dashes.
- `yarn format:check`: Prettier over the whole repository.
- `git diff --exit-code -- fixtures/footage/short-person.mp4`: the person clip is untouched.

## Patch Scope

**Lines of code to change:** about 6 lines of prose in `.adw/project.md`
**Risk level:** low
**Testing required:** none beyond format check and the greps above (documentation-only change; no
code, test or build behaviour changes)
