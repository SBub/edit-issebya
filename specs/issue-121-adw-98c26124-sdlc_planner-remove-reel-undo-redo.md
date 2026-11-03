# Chore: reel page: remove the Undo and Redo buttons from the player controls

## Metadata

issue_number: `121`
adw_id: `98c26124`
issue_json: `{"number":121,"title":"reel page: remove the Undo and Redo buttons from the player controls"}`

## Chore Description

The reel page's player control row carries two buttons, Undo and Redo, that show the previous or
next saved version in the preview without making it current. The owner removes them (decision of
2026-11-03): the Versions list and "Go back to this" cover going back. They write nothing (no
version, no job), so this is a UI-only change in `apps/studio` plus the docs that describe them.

After the change:

- The preview always shows the current version (`reels.current_version_id`).
- The player's control row is Play or Pause, the clock (`00:00 / 00:52`) and Zones. (The issue's
  "Position slider only" is out of date: since #132 the control row has no Position slider, the
  tracks timeline's ruler is the one scrubber, and `studio-reel-layout.md` forbids a second seek
  control. Zones stays: it is not part of this chore.)
- The Versions list no longer marks a "showing" version; `version-current` already marks the shown
  one.
- Going back is unchanged: "Go back to this" queues a `restore` job.
- The new-version hand-off is unchanged: `ReelPreview` keeps the previous built preview until the
  next current version is built, then mounts it with `startAt` and `autoPlay`.

The base is `origin/develop` at `7dcbf9f` (HEAD of this branch); everything the chore names is
there. `git grep -n -i -w -E "undo|redo|version-steps|previousVersionId|nextVersionId|shownVersionId|VersionSelection|selectedVersionId|version-showing|data-selected" -- apps/studio app_docs docs`
currently hits the 10 files the issue lists. `.adw/project.md` (outside that grep) also says
"and Undo and Redo changing only the shown version" in its Tests section and is updated too.

## Relevant Files

Use these files to resolve the chore:

- `README.md`, `AGENTS.md`: repository rules (no em-dashes, a change that breaks a doc Rule changes
  the rule in the same commit, conventional commits with no trailers).
- `.adw/project.md`: the ADW profile. Its Tests section describes `reel-layout.spec.ts` as checking
  "Undo and Redo changing only the shown version"; that phrase must change in the same commit
  (AGENTS.md: keep the profile in step). Never rename or reorder its nine `##` headings.
- `docs/conditional-docs.md`: line 25 (`studio-reel-layout.md`) ends its trigger list with
  "the player's control row or Undo and Redo"; drop "or Undo and Redo".
- `app_docs/studio-reel-layout.md`: the reel page doc. Lines 48 to 54 (ReelPreview / PreviewPlayer
  bullet: "builds the version being shown, not only the current one", "Zones, Undo, Redo"), lines
  58 to 60 (`version-steps.ts` bullet), How to Use step 4 (line 131), Testing (lines 144 to 153:
  the `version-steps` unit test and "Undo and Redo changing only the shown version"), Rule line 182
  ("Undo and Redo never create a version or queue a job").
- `app_docs/status.md`: line 81, "Undo and Redo hand off the same way." (remove; the rest of the
  hand-off paragraph stays).
- `app_docs/preview.md`: read only (matches "changing the studio live preview"); it has no Undo or
  Redo mention, so no edit.
- `apps/studio/src/components/LiveReel.tsx`: imports `@/lib/version-steps` (lines 29 to 34), holds
  the `selection` state (lines 149 to 151), derives `shownId`, `previousId`, `nextId` (lines 303 to
  305), defines `show`, `stepButton` and the `controls` fragment (lines 373 to 401), passes
  `versionId={shownId} controls={controls}` to `ReelPreview` (line 442) and
  `selectedVersionId={shownId}` to `VersionList` (line 468). Comment lines 122 to 130 mention Undo
  and Redo.
- `apps/studio/src/components/ReelPreview.tsx`: `ReelPreview` takes `controls: ReactNode` (lines
  196 to 204) and renders it in `note()` (line 256) and through `BuiltPreview` (line 272);
  `BuiltPreview` takes `controls` (lines 145 to 153) and hands it to `PreviewPlayer` (line 173).
  Comment line 189 to 194 says "the current one unless Undo or Redo picked another". `ReactNode` is
  imported (line 13) only for these two prop types.
- `apps/studio/src/components/PreviewPlayer.tsx`: `controls?: ReactNode` prop (lines 21 to 22),
  destructured (line 106), rendered at the end of the control row (line 497). `ReactNode` (line 4)
  is used only there. `data-preview`, `data-preview-version`, `data-version-id`, `data-intent`
  stay.
- `apps/studio/src/components/VersionList.tsx`: `selectedVersionId` prop (lines 14 to 15, 26), the
  `selected` flag (line 66), `data-selected` (line 73), the `bg-raised` class it drives (line 74)
  and the `version-showing` span (lines 83 to 87). `requestRestore`, `goBack` and the "Go back to
  this" button stay byte-for-byte.
- `apps/studio/src/lib/version-steps.ts`, `apps/studio/src/lib/version-steps.test.ts`: deleted (only
  caller is `LiveReel`).
- `apps/studio/e2e/reel-layout.spec.ts`: the last test, "Undo and Redo show the previous and next
  saved version and write nothing" (lines 562 to the end), is replaced. Helpers `openReel`,
  `versionRows`, `DESKTOP`, `PHONE`, `admin`, `reel` are reused. The phone test (lines 239 to 287)
  shows that `version-item` rows are in the DOM but hidden on the Edit tab.
- `apps/studio/src/app/preview-actions.ts`: read only; `loadPreviewSources(reelId, versionId?)`
  stays as is.
- `knip.json`, `lefthook.yml`, `turbo.json`: the dead-code, hook and task configs; no edit, but
  `yarn knip` must report neither `version-steps.ts` nor a leftover `controls` type.

### New Files

None. (The new test goes into the existing `apps/studio/e2e/reel-layout.spec.ts`.)

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Delete the version-steps helper

- `git rm apps/studio/src/lib/version-steps.ts apps/studio/src/lib/version-steps.test.ts`.

### 2. `PreviewPlayer.tsx`: drop the `controls` prop

- Remove the `controls?: ReactNode;` prop and its comment "Extra buttons at the end of the control
  row (Undo and Redo)." from `Props`.
- Remove `controls,` from the destructuring and `{controls}` from the end of the control row (after
  the Zones button).
- Change the React import to `import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";`
  (drop `type ReactNode`, now unused).
- Leave the Zones button, its `ml-auto`, and every `data-*` attribute on the wrapper untouched.

### 3. `ReelPreview.tsx`: drop the `controls` prop and its wrapper

- `BuiltPreview`: remove `controls` from the destructuring and the prop type, and remove
  `controls={controls}` from `<PreviewPlayer>`.
- `ReelPreview`: remove `controls` from the destructuring and the prop type (and its comment
  "Undo and Redo, shown in the player's control row."); the signature becomes
  `{ reelId, versionId }: { reelId: string; versionId: string | null }`.
- In `note()`, remove the line
  `{versionId && <div className="flex items-center gap-2">{controls}</div>}`.
- Remove `controls={controls}` from `<BuiltPreview>`.
- Drop `type ReactNode` from the React import (line 13) if nothing else uses it (today nothing
  does; `yarn typecheck` and `yarn lint` confirm).
- Rewrite the comment above `ReelPreview` so it no longer mentions Undo or Redo, for example:
  "The live preview of the reel's current version with its tracks timeline. It loads when the
  current version changes (LiveReel follows the reel through Realtime): no reload, no polling. A
  load overtaken by a newer version is dropped. While the next version loads, the previous one
  keeps playing; the next one then takes over at the same time, playing or paused as it was."
- Do not change `loadPreview`, the hand-off (`handoffRef`, `FIRST_OPEN`, `startAt`, `autoPlay`,
  `onHandoff`), the outcome logic or `loadPreviewSources`.

### 4. `VersionList.tsx`: drop the shown-version marker

- Remove the `selectedVersionId?: string | null;` prop and its comment "(Undo and Redo move it)".
- Remove `selectedVersionId = null,` from the destructuring and the `const selected = ...` line.
- Remove `data-selected={selected ? "true" : undefined}` and make the class
  `className="flex flex-col gap-1 px-3 py-2"` (no `bg-raised` highlight).
- Remove the `{selected && !current && (<span data-testid="version-showing" ...>showing</span>)}`
  block.
- Keep `version-item`, `data-version-number`, `data-current`, `version-current`, `version-origin`,
  `version-summary`, `requestRestore`, `goBack` and the "Go back to this" button exactly as they are.

### 5. `LiveReel.tsx`: always show the current version

- Remove the `@/lib/version-steps` import block (`VersionSelection`, `nextVersionId`,
  `previousVersionId`, `shownVersionId`).
- Remove the `selection` state and its comment ("The owner's Undo or Redo pick ...").
- Remove `shownId`, `previousId`, `nextId`; keep `const currentId = reel.current_version_id;`.
- Remove the `show` helper, its comment, `stepButton` and the `controls` fragment.
- Render `<ReelPreview reelId={reel.id} versionId={currentId} />`.
- Render `<VersionList ... currentVersionId={currentId} blockedReason={blockedReason} />` without
  `selectedVersionId`.
- Update the component comment (lines 122 to 130): "the shown version's preview and tracks timeline
  with Undo and Redo" becomes "the current version's preview and tracks timeline".
- Keep `ReactNode` in the React import (still used by `library: ReactNode`); keep the
  `noticeId` / `New version N` logic untouched.

### 6. `reel-layout.spec.ts`: replace the Undo and Redo test

- Delete the test "Undo and Redo show the previous and next saved version and write nothing".
- Add, in its place (last in the serial file):

  ```ts
  test("no Undo or Redo: the preview shows the current version at both sizes", async ({
    page,
    baseURL,
  }) => {
    const { data, error } = await admin
      .from("reels")
      .select("current_version_id")
      .eq("id", reel!.reelId)
      .single<{ current_version_id: string }>();
    if (error || !data) throw new Error(`reel not read: ${error?.message}`);
    const currentId = data.current_version_id;
    const newest = (await versionRows()).at(-1)!;
    expect(currentId).toBe(newest.id);

    for (const viewport of [DESKTOP, PHONE]) {
      await openReel(page, baseURL!, viewport);
      for (const name of ["Undo", "Redo"]) {
        await expect(
          page.getByRole("button", { name, exact: true, includeHidden: true }),
        ).toHaveCount(0);
      }
      await expect(
        page.locator(`[data-preview-version="${currentId}"][data-preview="ready"]`),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator(`[data-testid="version-item"][data-version-number="${newest.number}"]`),
      ).toHaveAttribute("data-current", "true");
      await expect(page.locator('[data-testid="version-item"][data-selected]')).toHaveCount(0);
      await expect(page.getByTestId("version-showing")).toHaveCount(0);
    }
  });
  ```

  `includeHidden: true` keeps the absence check meaningful on the phone, where other tabs' content
  is hidden; `exact: true` keeps unrelated labels from matching. Use the file's existing helpers
  (`openReel`, `versionRows`, `admin`, `reel`, `DESKTOP`, `PHONE`); no new import is needed. Keep
  the no-scroll tests at 1440x900 and 390x844 as they are.

### 7. Docs (same commit)

- `app_docs/studio-reel-layout.md`:
  - The `ReelPreview.tsx`, `PreviewPlayer.tsx` bullet: replace "the preview now builds the version
    being shown, not only the current one, and exposes the player's clock to the controls row (Play
    or Pause, `00:00 / 00:52`, then the extra buttons: Zones, Undo, Redo)" with "the preview builds
    the reel's current version (`reels.current_version_id`) and exposes the player's clock to the
    control row (Play or Pause, `00:00 / 00:52`, then Zones)". Keep the rest of the bullet (no
    Position slider, the ruler as the one scrubber, `PreviewPlayerHandle.seek`).
  - The `preview-actions.ts` bullet: keep it (the signature stays), optionally noting that the
    page passes the current version's id.
  - Remove the `apps/studio/src/lib/version-steps.ts` bullet.
  - How to Use step 4: becomes "Use "Go back to this" in the Versions area to make an older
    version current (it saves a new version copying the old one); the preview always shows the
    current version."
  - Testing: drop `version-steps` from the unit list; replace "and Undo and Redo changing only the
    shown version" with "and no Undo or Redo button, the preview showing the current version and no
    version marked as showing, at both sizes".
  - Rules: remove "Undo and Redo never create a version or queue a job." (the feature is gone; no
    replacement rule, per the owner's decision).
- `app_docs/status.md` line 81: remove the sentence "Undo and Redo hand off the same way." and keep
  the rest of the paragraph (the hand-off and `data-version-id`, `data-intent`).
- `docs/conditional-docs.md` line 25: "the player's control row or Undo and Redo;" becomes "the
  player's control row;".
- `.adw/project.md` Tests section: in the `reel-layout.spec.ts` description, replace "and Undo and
  Redo changing only the shown version" with "and no Undo or Redo button, the preview showing the
  current version". Change nothing else in the profile.
- No em-dashes anywhere; `app_docs/change-requests.md` and `app_docs/landing-page.md` ("undone")
  stay untouched.

### 8. Negative check for the new spec (temporary, never committed)

- Temporarily add `<button type="button" aria-label="Undo">x</button>` into `PreviewPlayer`'s
  control row (or as a `LiveReel` child rendered next to `ReelPreview`), run
  `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e --filter=./apps/studio -- reel-layout.spec.ts -g "no Undo or Redo"`
  and confirm the new test fails on the Undo count.
- Revert the probe (`git checkout -- <file>`), confirm `git status` and `git diff` show no trace of
  it.

### 9. Run the Validation Commands

- Run every command below; all must pass.

## Test Coverage

- E2E (`apps/studio/e2e/reel-layout.spec.ts`, chromium, the studio's Playwright suite): the new test
  "no Undo or Redo: the preview shows the current version at both sizes" opens the seeded reel at
  1440x900 and 390x844 and asserts no button named Undo or Redo exists, the preview is the current
  version's (`[data-preview-version="<current id>"][data-preview="ready"]`), and no `version-item`
  carries `data-selected` or contains `version-showing`. It fails without this change (the buttons
  are there today) and catches anyone putting a shown-version selector back; step 8 proves it fails
  on a probe.
- The existing no-scroll tests in the same file keep covering that Send and Export stay inside the
  root box with the narrower control row; `preview.spec.ts` and `progress-overlay.spec.ts` keep
  covering the preview and the new-version hand-off, which this change must not break.
- Unit: no new test. `version-steps.test.ts` is deleted with the helper it tests; nothing else in
  the unit layer changes behaviour.

## Validation Commands

Execute every command to validate the chore is complete with zero regressions.

- `git grep -n -i -w -E "undo|redo|version-steps|previousVersionId|nextVersionId|shownVersionId|VersionSelection|selectedVersionId|version-showing|data-selected" -- apps/studio app_docs docs .adw/project.md`: prints only lines of the new reel-layout test (the absence assertions) and, if any, doc lines that describe that test ("no Undo or Redo button"). Nothing in `src/`, no `version-steps`.
- `yarn format:check`: Prettier over the whole repository (the hook formats staged files only).
- `yarn turbo run lint --filter=./apps/studio`: ESLint on the changed components and spec (unused imports such as `ReactNode`).
- `yarn turbo run typecheck --filter=./apps/studio`: no caller still passes `controls` or `selectedVersionId`; `version-steps` imports gone.
- `yarn knip`: no unused file, export or type (`version-steps.ts`, a `controls` prop type).
- `yarn turbo run test --filter=./apps/studio`: the studio's unit tests pass without `version-steps.test.ts`.
- `yarn turbo run build --filter=./apps/studio`: the studio still builds (`next build`).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e --filter=./apps/studio`: the landing suite then the whole studio suite, including all of `reel-layout.spec.ts` (the new test and the no-scroll checks at 1440x900 and 390x844), `preview.spec.ts` and `progress-overlay.spec.ts`; run against the `/prepare_app` server on this run's port, never with `CI=1`.
- `git status`: clean apart from the intended changes; no trace of the step 8 probe.

## Notes

- `yarn test:db` is not needed: no migration, table, policy or function changes.
- Do not touch going back: `requestRestore`, `apps/studio/src/app/change-actions.ts`, the `restore`
  job kind, `restore-step.ts`, `restoreVersion`, the "Go back to this" button and
  `app_docs/change-requests.md` stay byte-for-byte. `VersionList`'s comment "going back can be
  undone too" is about restore and stays (the grep's `-w` skips "undone").
- `loadPreviewSources(reelId, versionId?)` keeps its signature; `ReelPreview` passes the current id.
- The issue's control row wording ("Play or Pause, time, Position slider only") predates #132: the
  Position slider is gone and must not come back (Rule: "Never add a second seek control"). The row
  after this change is Play or Pause, the clock and Zones.
- Removing the controls wrapper from `note()` removes the only content under the "No version yet"
  / loading messages besides the text; the layout around it (`flex-1`, centred) stays, so the
  no-scroll rule is unaffected.
- Commit as one conventional commit, e.g. `chore: remove the reel page's Undo and Redo buttons`,
  with no trailers (the profile forbids `Co-Authored-By`).
