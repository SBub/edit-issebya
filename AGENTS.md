# Agent instructions

Rules for working in this repository. What each feature does is not described here: read
`docs/conditional-docs.md` and the docs whose line matches your task.

## Tooling

- Yarn only (4.18.1 Berry, pinned via `packageManager` and corepack). Never npm
  or npx; `yarn dlx` if a one-off binary is unavoidable.
- lefthook runs on every commit: Prettier on staged files (re-staged
  automatically), `yarn lint`, `yarn typecheck`, `yarn knip`; and `yarn test`
  on every push. Hooks install through `postinstall` on `yarn install`. Do not
  bypass them.
- Conventional-commit messages (`feat:`, `fix:`, `chore:`, `docs:`). No
  trailers of any kind: no `Co-Authored-By`, no `Signed-off-by`.
- Default branch is `develop`.
- Turborepo monorepo on Yarn workspaces (`apps/*`, `packages/*`). Run every
  command from the repository root; the root scripts go through `turbo.json`
  (prettier and knip run once over the whole repository). Never `cd` into a
  workspace to install. Add a dependency to the workspace that uses it
  (`yarn workspace @edit-issebya/web add <pkg>`); the root `package.json` holds
  shared tooling only. Create a package under `packages/` only when two or more
  apps consume it.
- Turbo runs tasks in strict env mode: a variable a task reads must be listed in
  `turbo.json` (`env` for `build`, `passThroughEnv` for `dev`, `start` and
  `test:e2e`), or the task never sees it.
- `next dev` in Next 16 wants to write its own `AGENTS.md` and `CLAUDE.md`.
  That is switched off in `apps/web/next.config.ts` (`agentRules: false`); these two
  files are maintained by hand. Still read the relevant guide under
  `node_modules/next/dist/docs/` before Next.js work; the framework moves
  faster than training data.
- No em-dashes in any file. Use commas, periods, colons or parentheses.
- Never create, read or commit a real `.env*` file. The `.env.example` files hold placeholder names
  only: `apps/web/.env.example` for the app (Next reads env files from `apps/web/`), the root one
  for the ADW toolkit's `.env.development`.
- `.adw/project.md` is this repository's ADW profile; the toolkit's slash commands
  read it before anything else. When a change renames a script, moves a port,
  adds an env file or changes where docs live, update the profile in the same
  change, and never rename or reorder its nine `##` headings.

## Testing

- Unit tests are `apps/web/src/**/*.test.ts` (Vitest). Browser tests are
  `apps/web/e2e/*.spec.ts` (`@playwright/test`, chromium). A user-visible change adds or extends
  a spec.
- Measure fixed or edge-aligned elements from the root box
  (`document.documentElement.getBoundingClientRect()` or `clientWidth`), never from
  `window.innerWidth`: `scrollbar-gutter: stable` reserves 15px on Linux Chromium (CI) and
  nothing on macOS, so a window-based check passes locally and fails in CI.

## Documentation

- One doc per feature in `app_docs/`, one line per doc in `docs/conditional-docs.md`.
  `README.md` is human-facing (what the app is, how to run it, links into the docs); this file
  holds rules only. Never describe a feature here or in `README.md`.
- Every "do not" and "never" in a feature doc's Rules section is an invariant, as binding as a
  rule in this file. A change that breaks one changes the rule in that doc in the same commit.
