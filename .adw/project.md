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
- kind: `monorepo`. Yarn workspaces `apps/*` and `packages/*` under Turborepo (`turbo.json`), no
  `pyproject.toml`. One workspace today: the Next.js 16 app (App Router) in `apps/web`
  (`@edit-issebya/web`), the one-page landing site for edit.issebya.com; `packages/` is empty. It
  sells through Stripe Checkout (a server action), sends a confirmation email after payment
  through a Stripe webhook and Resend (`/api/stripe/webhook`), and measures with PostHog (browser,
  production only); all are optional at build and run time.
- default branch: `develop`. `master` is production.
- package manager: Yarn 4.18.1 (Berry, node-modules linker, pinned via `packageManager`, provided by
  corepack). Never `npm`, `npx`, `pnpm` or `bun`; `yarn dlx` only for an unavoidable one-off binary.
- Node: 24 (`.nvmrc`; `volta` pins 24.21.0).

## Workspaces

| name | path       | dev command                                                                      | port variable | default port | health URL | ADW may start |
| ---- | ---------- | -------------------------------------------------------------------------------- | ------------- | ------------ | ---------- | ------------- |
| web  | `apps/web` | `E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn workspace @edit-issebya/web dev` | `PORT`        | 3000         | `/`        | yes           |

- `name` is the directory under `apps/`; the package name is `@edit-issebya/web`. Resolve a
  `target_apps` name to its directory by matching either under `apps/*` and `packages/*`.
- The app's `dev` script is exactly `next dev`; it takes its port from `PORT`, so nothing passes
  `--port`. The root `yarn dev` runs it through turbo (`turbo run dev`, which passes `PORT` and the
  mock flags through); ADW uses the workspace command above so it starts this app alone once more
  workspaces exist.
- The mock flags turn on the in-process Stripe and Resend mocks (`apps/web/src/instrumentation.ts`)
  and the `/api/e2e-stripe-mock` and `/api/e2e-resend-mock` routes the checkout and confirmation
  email specs need.
- `/` answering 200 proves the server is up. The app reads no database; it calls Stripe when the
  form is submitted and Stripe and Resend when the webhook is called, and under the flags those
  calls never leave the process.
- `target_apps`: `/classify_app` answers `{"target_apps": ["web"]}` for a change under `apps/web`
  and `{"target_apps": []}` for a change to root files only (docs, `specs/`, tooling). Commands then
  filter with `--filter=./apps/web` (see Build); with `apps/web` the only workspace, a filtered and
  an unfiltered run do the same work.

## Install

From the worktree root, in order. The main checkout is two directories up from `trees/<adw_id>/`.

1. Copy from the main checkout, each only if it exists there, preserving its path:
   `.env.development` at the root (ADW toolkit configuration), and `apps/web/.env.development`
   (read by `next dev`) and `apps/web/.env.local` (read in every mode). Next reads env files from
   the app's folder, never from the repository root. None is required: the page builds and runs
   with no variables. Never copy an `.env.example`; never invent a value for a missing file.
2. `yarn install --immutable` (every workspace; `postinstall` runs `lefthook install`). An install
   that would change `yarn.lock` is a finding, not something to paper over with a mutable install.
3. `yarn workspace @edit-issebya/web playwright install chromium webkit`, the browsers
   `@playwright/test` needs (WebKit runs only `apps/web/e2e/dialog_form.spec.ts`). Browsers live in
   the user cache, so this is a no-op once present. On macOS 14 the local WebKit build is frozen
   and cannot open a page: point `PW_WEBKIT_WS` at a `playwright run-server` in the official Linux
   image instead (see `app_docs/checkout.md`, "Form dialog layout").
4. Verify with `yarn build` (see Build).

Do not start the dev server during install.

## Build

- `yarn turbo run build --filter=./apps/web` for a change in the app; `yarn build` (the unfiltered
  `turbo run build`) for a root-only change or an unknown target. `--filter` takes the directory
  path, repeated per target workspace. The app's build is `next build`; turbo caches `.next` in
  `.turbo/cache` (local to each worktree) and replays it when nothing it reads changed.
- Needs no environment variables. Optional:
  `STRIPE_SECRET_KEY`, `STRIPE_AUTOMATIC_TAX`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
  `EMAIL_FROM`, `EMAIL_REPLY_TO`, `BOOKING_URL` (server), `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`,
  `NEXT_PUBLIC_POSTHOG_HOST` and `NEXT_PUBLIC_VERCEL_ENV` (set by Vercel, never by hand). Turbo
  runs in strict env mode: a variable a task reads must be listed for that task in `turbo.json`.

## Tests

In the order the test phase runs them, all from the root (`<filter>` is `--filter=./apps/web`, or
nothing for a root-only change; the plain root scripts `yarn lint`, `yarn typecheck`, `yarn test`,
`yarn build` and `yarn test:e2e` are the unfiltered `turbo run` forms): lint
`yarn turbo run lint <filter>` (autofix `lint:fix`; `apps/web/eslint.config.mjs`); typecheck
`yarn turbo run typecheck <filter>` (`next typegen` then `tsc --noEmit` in `apps/web`; it rewrites
the gitignored `apps/web/next-env.d.ts`, never stage it); dead code `yarn knip` (whole repository,
one root `knip.json` with a workspace per package); format `yarn format:check` (whole repository;
write `yarn format`); unit `yarn turbo run test <filter>` (vitest, `apps/web/src/**/*.test.ts` only,
see `apps/web/vitest.config.ts`); build as in Build; and last the E2E suite `yarn test:e2e`.

The unit layer is `apps/web/src/**/*.test.ts` for pure helpers in `apps/web/src/lib/`. There is no
component test layer; the browser layer is the Playwright suite below.

E2E code suite: `apps/web/e2e/*.spec.ts` (`@playwright/test`, chromium, plus webkit for the dialog
spec, `apps/web/playwright.config.ts`), run last by the test phase as `PORT=<run port> yarn
test:e2e` (turbo passes `PORT`, `CI`, `PW_*` and the mock flags through; extra Playwright arguments
go after `--`). The `/prepare_app` server must already be up on this run's port, started with the
Workspaces dev command (an adopted server never sees `webServer.env`, and the checkout and
confirmation email specs need the mocks), which `reuseExistingServer` adopts; never set `CI=1` in a
run (it disables reuse and switches the server to `yarn start`). Specs run with `workers: 1`: they
share one server's mock state (Stripe capture and sessions, Resend recording) and its missing-key
and missing-config toggles. A user-visible change adds or extends a spec there.
Measure fixed or edge-aligned elements from the root box, never from `window.innerWidth`
(`scrollbar-gutter: stable` reserves 15px on Linux Chromium and none on macOS).

lefthook runs prettier, `yarn lint`, `yarn typecheck` and `yarn knip` on every commit and
`yarn test` on every push, all from the root (lint, typecheck and test through turbo).
`yarn test:e2e` is in neither hook. Never bypass it. CI
(`.github/workflows/ci.yml`, job `check`) runs format check, lint, typecheck, knip, unit, build
and E2E on every pull request and push to `develop` and `master`.

## Ports

- Nothing in this repository is pinned to a port and nothing external holds a URL against one.
  `next dev` honours `PORT` (turbo passes it through) and defaults to 3000.
- This run's port is in `.ports.env` at the worktree root (`PORT`, `BACKEND_PORT`, `FRONTEND_PORT`),
  written by the engine. Source it; never write, edit or delete it; fall back to 3000 only when it
  is absent. A server on 3000 when `PORT` is not 3000 is the developer's or an older run's: never
  reuse, probe, `lsof` or kill it.

## Protected

- Never `npm`, `npx`, `pnpm` or `bun`. A new dependency goes to the workspace that uses it:
  `yarn workspace @edit-issebya/web add <pkg>` (or `add -D`); `yarn add -D <pkg>` at the root only
  for shared tooling. Never install from inside a workspace folder.
- Never pass `--no-verify`; never weaken a rule, a type or a test to make a check pass.
- Never kill a process this run did not start; never change a port through `package.json`,
  `.ports.env` or any committed file.
- Never stage `next-env.d.ts`, `.ports.env`, `.env*` (except the two `.env.example` files),
  `.turbo/`, `agents/` or `trees/`.
- Never commit a real Stripe, Resend or PostHog key; the `.env.example` files hold placeholders
  only. Never create a real charge, send a real email or set up a deployment, domain or
  third-party account.
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
- A helper in `apps/web/src/lib/` has no rendered surface: no visual review, evidence is the diff,
  the tests and the spec's commands.
- Browser automation is the Playwright MCP server in `.mcp.json`: the devDependency
  `@playwright/mcp` of the root `package.json`, pinned to exactly `0.0.81`, run from `node_modules`
  through `yarn playwright-mcp --isolated` at the root (no `yarn dlx`), configured by the root
  `playwright-mcp-config.json` (headless chromium, 1920x1080). An upgrade is a change to that pin.
