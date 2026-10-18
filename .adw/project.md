# ADW project profile

The ADW (AI Developer Workflow) profile of this repository. The toolkit's slash commands
(`.claude/commands/*.md`, a symlink into `adw-toolkit/commands/`) read it before anything else:
what this repository is, how it installs, builds and tests, which ports matter, what must never run
here. Committed so every worktree under `trees/<adw_id>/` carries it. The nine `##` headings and
their order are a contract with those commands (`adws/PROFILE.md` in the toolkit): add facts under
them, never rename or reorder them. `AGENTS.md` holds the working rules and the feature docs under
`app_docs/` hold each feature's rules; this file restates the subset the ADW commands need and must
be kept in step with them and with `README.md`.

## Identity

- name: `edit-issebya`
- kind: `single-app`. One Next.js 16 app (App Router) at the repository root: the one-page landing
  site for edit.issebya.com. No workspaces, no task runner, no `apps/*`, no `pyproject.toml`.
  It sells through Stripe Checkout (a server action) and measures with PostHog (browser, production
  only); both are optional at build and run time.
- default branch: `develop`. `master` is production.
- package manager: Yarn 4.18.1 (Berry, node-modules linker, pinned via `packageManager`, provided by
  corepack). Never `npm`, `npx`, `pnpm` or `bun`; `yarn dlx` only for an unavoidable one-off binary.
- Node: 24 (`.nvmrc`; `volta` pins 24.21.0).

## Workspaces

| name         | path | dev command                     | port variable | default port | health URL | ADW may start |
| ------------ | ---- | ------------------------------- | ------------- | ------------ | ---------- | ------------- |
| edit-issebya | `.`  | `E2E_MOCK_STRIPE=true yarn dev` | `PORT`        | 3000         | `/`        | yes           |

- `yarn dev` is exactly `next dev`; it takes its port from `PORT`, so nothing passes `--port`.
- ADW starts it as `E2E_MOCK_STRIPE=true yarn dev`: the flag turns on the in-process Stripe mock
  (`src/instrumentation.ts`) and the `/api/e2e-stripe-mock` route the checkout specs need.
- `/` answering 200 proves the server is up. The app reads no database; it calls Stripe only when
  the form is submitted, and under the flag that call never leaves the process.
- `target_apps` from the engine is always empty for this repository; every command runs from the
  root, unfiltered. `/classify_app` answers `{"target_apps": []}` here.

## Install

From the worktree root, in order. The main checkout is two directories up from `trees/<adw_id>/`.

1. Copy from the main checkout, each only if it exists there: `.env.development` (read by
   `yarn dev` and by the ADW toolkit) and `.env.local` (read in every mode). Neither is required:
   the page builds and runs with no variables. Never copy `.env.example`; never
   invent a value for a missing file.
2. `yarn install --immutable` (`postinstall` runs `lefthook install`). An install that would change
   `yarn.lock` is a finding, not something to paper over with a mutable install.
3. `yarn playwright install chromium`, the browser `@playwright/test` needs. Browsers live in the
   user cache, so this is a no-op once present.
4. Verify with `yarn build` (see Build).

Do not start the dev server during install.

## Build

- `yarn build` (`next build`, unfiltered). Needs no environment variables. Optional:
  `STRIPE_SECRET_KEY`, `STRIPE_AUTOMATIC_TAX` (server), `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`,
  `NEXT_PUBLIC_POSTHOG_HOST` and `NEXT_PUBLIC_VERCEL_ENV` (set by Vercel, never by hand).

## Tests

In the order the test phase runs them, all from the root, unfiltered: lint `yarn lint` (autofix
`yarn lint:fix`; `eslint.config.mjs` ignores `trees/**` and `agents/**`); typecheck
`yarn typecheck` (`next typegen` then `tsc --noEmit`; `tsconfig.json` excludes `trees` and
`agents`; it rewrites the gitignored `next-env.d.ts`, never stage it); dead code `yarn knip`
(scans `src/**` and `e2e/**`, see `knip.json`); format `yarn format:check` (write `yarn format`);
unit `yarn test` (vitest, `src/**/*.test.ts` only, see `vitest.config.ts`); build `yarn build`;
and last the E2E suite `yarn test:e2e`.

The unit layer is `src/**/*.test.ts` for pure helpers in `src/lib/`. There is no component test
layer; the browser layer is the Playwright suite below.

E2E code suite: `e2e/*.spec.ts` (`@playwright/test`, chromium, `playwright.config.ts`), run last by
the test phase as `PORT=<run port> yarn test:e2e`. The `/prepare_app` server must already be up on
this run's port, started as `E2E_MOCK_STRIPE=true yarn dev` (an adopted server never sees
`webServer.env`, and the checkout specs need the mock), which `reuseExistingServer` adopts; never
set `CI=1` in a run (it disables reuse and switches the server to `yarn start`). Specs run with
`workers: 1`: they share one server's mock capture and missing-key toggle. A user-visible change adds or extends a spec there.
Measure fixed or edge-aligned elements from the root box, never from `window.innerWidth`
(`scrollbar-gutter: stable` reserves 15px on Linux Chromium and none on macOS).

lefthook runs prettier, `yarn lint`, `yarn typecheck` and `yarn knip` on every commit and
`yarn test` on every push. `yarn test:e2e` is in neither hook. Never bypass it. CI
(`.github/workflows/ci.yml`, job `check`) runs format check, lint, typecheck, knip, unit, build
and E2E on every pull request and push to `develop` and `master`.

## Ports

- Nothing in this repository is pinned to a port and nothing external holds a URL against one.
  `next dev` honours `PORT` and defaults to 3000.
- This run's port is in `.ports.env` at the worktree root (`PORT`, `BACKEND_PORT`, `FRONTEND_PORT`),
  written by the engine. Source it; never write, edit or delete it; fall back to 3000 only when it
  is absent. A server on 3000 when `PORT` is not 3000 is the developer's or an older run's: never
  reuse, probe, `lsof` or kill it.

## Protected

- Never `npm`, `npx`, `pnpm` or `bun`. A new dependency is `yarn add <pkg>` or `yarn add -D <pkg>`.
- Never pass `--no-verify`; never weaken a rule, a type or a test to make a check pass.
- Never kill a process this run did not start; never change a port through `package.json`,
  `.ports.env` or any committed file.
- Never stage `next-env.d.ts`, `.ports.env`, `.env*` (except `.env.example`), `agents/` or `trees/`.
- Never commit a real Stripe, Resend or PostHog key; `.env.example` holds placeholders only. Never
  create a real charge, send a real email or set up a deployment, domain or third-party account.
- No em-dashes in any file. Use commas, periods, colons or parentheses.
- Every "do not" in `AGENTS.md` and in the Rules of the feature docs under `app_docs/` is an
  invariant.

## Documentation

- Plans: `specs/issue-<issue_number>-adw-<adw_id>-sdlc_planner-<slug>.md`; patch plans:
  `specs/patch/patch-adw-<adw_id>-<slug>.md`.
- Feature docs: `app_docs/<feature-slug>.md`, one file per feature, updated in place by later runs
  (never a second file for a feature the index lists). Assets: `app_docs/assets/`. `README.md`
  holds what the app is and how to run it, `AGENTS.md` holds rules; neither describes a feature. A
  change to `specs/`, tests alone or a dependency bump needs no documentation. `CLAUDE.md` is an
  include of `AGENTS.md`. No dated changelog entries.
- Index to update: `docs/conditional-docs.md`, one line per doc in `app_docs/`, saying when to read
  it.
- Read before planning: `AGENTS.md`, then `docs/conditional-docs.md` and the docs whose line
  matches; the installed Next docs under `node_modules/next/dist/docs/` for any Next.js work.
- Commits: Conventional Commits with a bare type and no scope (`feat: ...`, `fix: ...`,
  `chore: ...`). No trailers of any kind: no `Co-Authored-By`, no `Signed-off-by`, no "Generated
  with". The `adw: <agent> <id>` body line is a body line, not a trailer.
- Required trailer: none.

## Review

- Open at `http://localhost:$PORT`: `/` (the one-screen landing page), `/` after clicking "Book
  your discovery call" (the form dialog open), and `/?checkout=success&session_id=cs_test_review`
  (the thank-you dialog). Capture each at 1920x1080, 375x667 and 320x568, nine captures,
  viewport-sized, not full page (the page must never scroll), into
  `agents/<adw_id>/<agent_name>/review_img/` in the worktree.
- A helper in `src/lib/` has no rendered surface: no visual review, evidence is the diff, the tests
  and the spec's commands.
- Browser automation is the Playwright MCP server in `.mcp.json`: the devDependency
  `@playwright/mcp`, pinned to exactly `0.0.81`, run from `node_modules` through
  `yarn playwright-mcp --isolated` (no `yarn dlx`), configured by `playwright-mcp-config.json`
  (headless chromium, 1920x1080). An upgrade is a change to that pin in `package.json`.
