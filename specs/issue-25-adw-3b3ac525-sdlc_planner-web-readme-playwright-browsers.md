# Chore: docs: add apps/web README and fix the Playwright browsers line (ADW smoke test on the monorepo)

## Metadata

issue_number: `25`
adw_id: `3b3ac525`
issue_json: `{"number":25,"title":"docs: add apps/web README and fix the Playwright browsers line (ADW smoke test on the monorepo)"}`

## Chore Description

A small documentation change inside `apps/web` whose real purpose is a smoke test of ADW on the new
Turborepo monorepo layout (the landing page moved into `apps/web` by hand in PR #19, and
`.adw/project.md` was rewritten for it). The run must classify to the `web` workspace, install,
build and test with the filtered commands from the profile, and open a pull request against
`develop`. Visitors see no change.

The documentation change itself:

1. Add `apps/web/README.md`. The workspace has no README today, and `/classify_app` reads each
   candidate workspace's `README.md` first line to route an issue. The first line says this is the
   landing site for edit.issebya.com (Next.js, workspace `@edit-issebya/web`); then two or three
   lines point to the root `README.md` (how to run it), `docs/conditional-docs.md` (feature docs)
   and `AGENTS.md` (rules). It must describe no feature.
2. Fix the browser install line in the root `README.md` (line 32, under "Checks"): it installs only
   `chromium`, but `apps/web/playwright.config.ts` also runs a `webkit` project for
   `apps/web/e2e/dialog_form.spec.ts`, and `.adw/project.md` Install step 3 already installs
   `chromium webkit`. Change it to install `chromium webkit` so a fresh clone can run
   `yarn test:e2e`.

If any pipeline phase fails on the new layout, that is the finding: report the phase and the exact
error output, and do not work around it by editing `.adw/project.md`, `turbo.json`,
`package.json`, CI or any code.

## Relevant Files

Use these files to resolve the chore:

- `README.md` - root, human-facing README. Line 32 holds the browser install line to fix. Its
  "Docs" section shows the link style (relative markdown links) the new README should mirror.
- `apps/web/playwright.config.ts` - defines the `chromium` and `webkit` projects; the evidence
  that both browsers are needed. Read only, do not edit.
- `.adw/project.md` - Install step 3 (`yarn workspace @edit-issebya/web playwright install
chromium webkit`) is the wording to match; Identity gives the canonical description of the
  workspace ("the one-page landing site for edit.issebya.com"). Read only, do not edit.
- `AGENTS.md` - rules: `README.md` is human-facing and never describes a feature; no em-dashes;
  conventional commits with no trailers. `apps/web` has no `AGENTS.md` or `ENGINEERING.md` of its
  own.
- `docs/conditional-docs.md` - the feature doc index the new README links to. No line matches this
  task (no layout, checkout, analytics, email or legal change), so no feature doc is read or
  updated.
- `.prettierrc` - `printWidth: 100`; `yarn format:check` runs over the whole repository, markdown
  included, so both READMEs must be Prettier-clean.

### New Files

- `apps/web/README.md` - the workspace README read by `/classify_app`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Create `apps/web/README.md`

- Write exactly this content (no em-dashes; links are relative to `apps/web/`). The first line
  carries both the site and the workspace name, because `/classify_app` reads only the first line
  and Verification 1 checks `head -1`:

```md
# The landing site for edit.issebya.com (Next.js), workspace `@edit-issebya/web`

- How to install, run and check it: the root [`README.md`](../../README.md). Every command runs
  from the repository root.
- Feature docs: [`docs/conditional-docs.md`](../../docs/conditional-docs.md).
- Working rules: [`AGENTS.md`](../../AGENTS.md).
```

- Do not describe any feature (checkout, email, analytics, legal pages, reels).

### 2. Fix the browser install line in `README.md`

- Replace line 32
  `yarn workspace @edit-issebya/web playwright install chromium   # once`
  with
  `yarn workspace @edit-issebya/web playwright install chromium webkit   # once`
- Keep the `# once` comment; adjust only the spaces before it if you want it aligned with the
  `# Playwright specs` comment on the next line (inside a fenced block Prettier leaves it alone).
- Change nothing else in the file.

### 3. Format

- Run `yarn format` only if `yarn format:check` reports either README; stage nothing else it
  touches.

### 4. Run the Validation Commands

- Run every command below from the worktree root. Install per `.adw/project.md` Install is done by
  the install phase; `yarn install --immutable` must not change `yarn.lock`.
- If any check fails for a reason unrelated to the two READMEs, record the phase and exact error
  output as the finding; do not edit `.adw/project.md`, `turbo.json`, `package.json`, CI, hooks or
  code to make it pass.
- Commit as `docs: add apps/web README and install webkit in the README checks` with no trailers.

## Test Coverage

No test needed: the change is documentation only (a new `apps/web/README.md` and one command line in
the root `README.md`). Nothing renders or executes either file, so no unit or Playwright spec could
fail without it; `.adw/project.md` (Documentation) says a docs-only change needs no test or feature
doc. The existing suites still run in full as the smoke test this issue exists for. No E2E spec is
added because nothing visible changes; the review phase captures the profile's standard nine
screenshots of `/` as usual.

## Validation Commands

Execute every command to validate the chore is complete with zero regressions.

- `test -f apps/web/README.md && head -1 apps/web/README.md` - the README exists and its first line
  names the landing site and `@edit-issebya/web`.
- `grep -n "playwright install chromium webkit" README.md` - finds the fixed line.
- `! grep -n "playwright install chromium   # once" README.md` - the old line is gone.
- `! grep -rn "$(printf '\xe2\x80\x94')" apps/web/README.md README.md` - no em-dash.
- `yarn turbo run lint --filter=./apps/web` - lint, scoped to the target workspace.
- `yarn turbo run typecheck --filter=./apps/web` - typecheck (rewrites the gitignored
  `apps/web/next-env.d.ts`; never stage it).
- `yarn knip` - dead code, whole repository.
- `yarn format:check` - Prettier over the whole repository, including both READMEs.
- `yarn turbo run test --filter=./apps/web` - unit tests (Vitest).
- `yarn turbo run build --filter=./apps/web` - production build.
- `set -a; [ -f .ports.env ] && . ./.ports.env; set +a; PORT=${PORT:-3000} yarn test:e2e` - the E2E
  suite, last, against the `/prepare_app` server already running on this run's port (never set
  `CI=1`).
- `git diff --stat origin/develop` - lists exactly `README.md` and `apps/web/README.md` (plus this
  plan under `specs/`, which the pipeline commits).

## Notes

- Expected classification: `/classify_issue` answers `/chore`; `/classify_app` answers
  `{"target_apps": ["web"]}` because the new file lives under `apps/web`.
- The PR targets `develop`; CI job `check` in `.github/workflows/ci.yml` must be green on it.
- On macOS 14 the local WebKit build cannot open a page; if the webkit project fails locally, point
  `PW_WEBKIT_WS` at a `playwright run-server` in the official Linux image
  (`app_docs/checkout.md`, "Form dialog layout"), and report it rather than skipping the project.
- Out of scope: the profile, turbo, CI, hooks, Vercel, and READMEs for `apps/studio` and
  `apps/worker`.
