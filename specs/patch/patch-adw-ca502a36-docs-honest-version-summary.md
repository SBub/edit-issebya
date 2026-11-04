# Patch: Document the honest version summary (spec step 11)

## Metadata

adw_id: `ca502a36`
review_change_request: `Issue #1: Spec step 11 (documentation and profile) is not in the diff. Nothing under app_docs/, docs/conditional-docs.md or .adw/project.md changed. Some existing text is now false (change-requests.md line 81 and 142, decide-step.md decide-7, the two answer fields and the Rule at line 328, the profile's change-requests.spec.ts sentence, status.md and failures.md missing no-change). Resolution: carry out spec step 11. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-156-adw-ca502a36-sdlc_planner-honest-version-summary-from-diff.md`
**Issue:** The code change (decide answer `decide-8` without `change_title`/`change_summary`, the
version diff `packages/edit/src/version-diff.ts`, the summary schema, safeguard and template
`packages/edit/src/version-summary.ts`, the one summary call `apps/worker/src/decide/version-summary.ts`
with `summary.md` on `claude-haiku-5-5` and `SUMMARY_PROMPT_VERSION` `summary-1`, the
`NothingChanged` refusal with rules starting `no-change`, and the overlay headline `Nothing changed`)
shipped with no doc or profile update. Existing docs now state false things, and decide-step.md's
Rule about the prompt writing the two fields no longer holds (AGENTS.md: a broken Rule changes in
the same change).
**Solution:** Carry out spec step 11 exactly, docs and profile only, no code change. Read the code
under `apps/worker/src/decide/`, `packages/edit/src/version-*.ts`, `apps/worker/src/failure.ts`
and `apps/studio/src/lib/progress-overlay.ts`/`step-words.ts` on this branch to describe it
accurately. No em-dashes. Finish with `yarn format`.

## Files to Modify

- `app_docs/decide-step.md`
- `app_docs/change-requests.md`
- `app_docs/edit-model.md`
- `app_docs/status.md`
- `app_docs/failures.md`
- `docs/conditional-docs.md`
- `.adw/project.md` (Tests section only; no heading renamed or reordered)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: `app_docs/decide-step.md`

- Line 28: the answer is `decide-8`. Remove `change_title` and `change_summary` from the answer
  example (lines 45-46) and drop the field bullet at line 67 for them (keep the rest of that
  bullet: `format`, `preset`, `duration` and `inputs` from the current version, the title overlay).
- Line 124: `PROMPT_VERSION` is `decide-8`. Replace the sentence at lines 132-136 ("It asks for
  `change_title` ... internal names") with: the prompt no longer asks for a title or summary; they
  are written after layout from the saved difference (see the new section).
- Add a `### Version title and summary` section under How it works (before `### Failure`):
  `diffEdits(current, edit, transcript, preset)` in `packages/edit/src/version-diff.ts` lists the
  items added, removed, moved or changed per kind plus the behind rules changed (`ruleChanges`);
  `apps/worker/src/decide/version-summary.ts` (`writeVersionSummary`) makes one call on
  `SUMMARY_MODEL` `claude-haiku-5-5` with `summary.md`, given the request, the checklist outcome,
  the difference and the engine record; `packages/edit/src/version-summary.ts` holds the schema,
  the safeguard (every item kind the title or summary names must be in the difference, else the
  template replaces it) and the template (`No changes` for an empty difference, `Photos switched
off` for a forbid-only change); an empty difference makes no call; a refused, invalid or failed
  call falls back to the template and never fails the step or makes the job wait; its tokens and
  cost are added to the step's usage but not its model (`steps.ai_model`, `versions.model` stay
  the editor's); `SUMMARY_PROMPT_VERSION` (`summary-1`) is logged with the template line, not
  stored. Update the `runDecide` paragraph's save order: cutouts, behind rules, unchanged check,
  diff, summary, `saveVersion` with `changeTitle`/`changeSummary` from the summary.
- `### Failure`: a request whose edit bytes equal the current version and whose rules do not
  change throws `NothingChanged` (an `AnswerRefused`, rules `no-change` then the distinct drop
  rules, at most 20), tail `decide: nothing would change, version <n> stays current` plus the
  not-done asks; nothing written to R2 or `versions`. The automatic run (no request) still saves.
- `## Testing`: name `version-diff.test.ts`, `version-summary.test.ts` (package and worker), the
  new `run-decide.test.ts` cases and the `change-requests.spec.ts` unchanged-change test. Fix line
  288's `decide-7` to `decide-8`.
- `## Rules`: replace the line at 328-330 with the spec's five lines: "The version summary
  describes only the saved difference: every item it names is in the difference, else the template
  replaces it", "The summary call is one call, never retried, never fails the step or makes the
  job wait", "Never print a word id, font, size or time in a title or summary", "A request whose
  edit is identical to the current version saves nothing; the owner is told why", "Bump
  `SUMMARY_PROMPT_VERSION` whenever `summary.md` changes". Keep "Never clean old summaries with
  regexes; they show as stored." as its own line.
- Add the issue's spec to the doc's Specifications list.

### Step 2: `app_docs/change-requests.md`

- Line 81: "Texts: `change_title` and `change_summary` are written after layout from the saved
  difference, by the summary call or its template (`app_docs/decide-step.md`); a going back saves
  the summary `Back to how vN looked`. Old technical summaries stay as stored and show only inside
  the details."
- Line 142: replace with: "A change whose edit would be identical to the current version saves
  nothing; the job fails as a refused answer with rules starting `no-change` and the overlay says
  `Nothing changed` with the reason and Change the request / Keep the current version."
- Add a `## Rules` section (before `## Notes`) with "The version summary describes only the saved
  difference." and "An unchanged edit is never saved as a change."
- In `## Testing`, add the `change-requests.spec.ts` unchanged-change case.

### Step 3: `app_docs/edit-model.md`, `app_docs/status.md`, `app_docs/failures.md`

- `edit-model.md` Overview (lines 17-23): add `version-diff.ts` (`diffEdits`, `ruleChanges`, the
  structured difference between two edits) and `version-summary.ts` (summary schema, safeguard and
  template) to the package's contents, pointing to `app_docs/decide-step.md`.
- `status.md` around lines 56-66: a refused change job whose `failure_rules` include `no-change`
  has the headline `Nothing changed` (else the step's failed words); `RULE_WORDS` gains
  `no-change` ("your reel would look the same") and the other rule words step 8 added.
- `failures.md` around lines 38-41: `answer_refused` also covers a request whose edit changes
  nothing (`failure_rules` start with `no-change`), shown as `Nothing changed`.

### Step 4: Index and profile

- `docs/conditional-docs.md` line 16 (`decide-step.md`): add "the version title and summary
  (`summary.md`, `version-summary.ts`, `SUMMARY_PROMPT_VERSION`, the summary model) and the
  version diff (`packages/edit/src/version-diff.ts`)". Line 17 (`change-requests.md`): add "or
  what an unchanged request does (`Nothing changed`)".
- `.adw/project.md` Tests section, the `change-requests.spec.ts` sentence (line 201-203): after
  "going back makes versions 4 and 5", add ", an unchanged change saves nothing and the overlay
  says `Nothing changed`". Nothing else in the profile changes.

### Step 5: Format and check for em-dashes

- `grep -nP "\x{2014}" app_docs/*.md docs/conditional-docs.md .adw/project.md` returns nothing.
- Run `yarn format`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -rn "decide-7" app_docs/decide-step.md` returns nothing; `grep -n "Claude writes" app_docs/change-requests.md` returns nothing.
- `yarn format:check`
- `yarn knip`
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio --filter=...{./packages/edit}`
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio --filter=...{./packages/edit}`

## Patch Scope

**Lines of code to change:** about 80 lines of Markdown across 7 files, no code
**Risk level:** low
**Testing required:** format check and the unit layers (docs only; no behaviour change)
