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
  `pyproject.toml`. Two workspaces, both Next.js 16 (App Router): `apps/web`
  (`@edit-issebya/web`), the one-page landing site for edit.issebya.com, and `apps/studio`
  (`@edit-issebya/studio`), the reel studio served at `/studio` through Next.js multi-zones (the
  landing page forwards `/studio` and `/studio-static` to it). `apps/worker`
  (`@edit-issebya/worker`) is the job worker, TypeScript run directly by Node 24 on the owner's
  machine, never on Vercel. `packages/storage` (`@edit-issebya/storage`) is the storage interface,
  its R2 implementation and its folder fake, shared by the studio and the worker (TypeScript
  source, no build). The landing page sells through Stripe Checkout (a
  server action), sends a confirmation email after payment through a Stripe webhook and Resend
  (`/api/stripe/webhook`), and measures with PostHog (browser, production only); all are optional
  at build and run time. The studio signs in with a Supabase magic link and reads the `reels` table
  under row-level security.
- database: one shared local Supabase stack (`supabase/config.toml`, project `edit-issebya`, ports
  54430 to 54439), migrations in `supabase/migrations/`. The owner starts and keeps it running.
- default branch: `develop`. `master` is production.
- package manager: Yarn 4.18.1 (Berry, node-modules linker, pinned via `packageManager`, provided by
  corepack). Never `npm`, `npx`, `pnpm` or `bun`; `yarn dlx` only for an unavoidable one-off binary.
- Node: 24 (`.nvmrc`; `volta` pins 24.21.0).

## Workspaces

| name    | path               | dev command                                                                                                                                                                               | port variable | default port | health URL | ADW may start |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ | ---------- | ------------- |
| web     | `apps/web`         | `set -a; . ./.ports.env; set +a; STUDIO_PORT=$BACKEND_PORT E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true E2E_MOCK_STORAGE=true yarn turbo run dev --filter=./apps/web --filter=./apps/studio` | `PORT`        | 3000         | `/`        | yes           |
| studio  | `apps/studio`      | started with web                                                                                                                                                                          | `STUDIO_PORT` | 3001         | `/studio`  | no            |
| worker  | `apps/worker`      | none (specs spawn `once`)                                                                                                                                                                 | none          | none         | none       | never         |
| storage | `packages/storage` | none (library)                                                                                                                                                                            | none          | none         | none       | never         |

- `name` is the directory under `apps/` or `packages/`; the package names are
  `@edit-issebya/web`, `@edit-issebya/studio`, `@edit-issebya/worker` and `@edit-issebya/storage`. Resolve a `target_apps` name to its directory by matching either under
  `apps/*` and `packages/*`.
- The web dev command sources `.ports.env` first (`PORT`, `BACKEND_PORT`), then starts both apps
  through turbo (which passes `PORT`, `STUDIO_PORT` and the mock flags through): the landing page
  on `PORT`, the studio on `STUDIO_PORT`, set from the run's `BACKEND_PORT`. `FRONTEND_PORT` equals
  `PORT` and is never used for the studio. The studio is never started alone: it is reached
  through the landing page's address (`http://localhost:$PORT/studio`).
- The web app's `dev` script is exactly `next dev`; it takes its port from `PORT`, so nothing
  passes `--port`. The studio's is `next dev -p ${STUDIO_PORT:-3001}` (and `start` the same), since
  `PORT` belongs to the landing page. The landing page forwards to `http://localhost:$STUDIO_PORT`
  (default 3001) unless `STUDIO_URL` is set.
- The mock flags turn on the in-process Stripe and Resend mocks (`apps/web/src/instrumentation.ts`)
  and the `/api/e2e-stripe-mock` and `/api/e2e-resend-mock` routes the checkout and confirmation
  email specs need. `E2E_MOCK_STORAGE=true` makes the studio sign uploads to its
  `/studio/api/e2e-storage-mock` route, which writes into the gitignored `.e2e-storage/` folder at
  the worktree root, where the worker's `once` reads them.
- `/` answering 200 proves the landing server is up, `/studio` through it proves the studio is.
  The landing page reads no database; it calls Stripe when the form is submitted and Stripe and
  Resend when the webhook is called, and under the flags those calls never leave the process. The
  studio reads the shared local Supabase stack through `apps/studio/.env.development`; without it
  the studio shows a "not configured" notice.
- `target_apps`: `/classify_app` answers `{"target_apps": ["web"]}` for a change under `apps/web`,
  `{"target_apps": ["studio"]}` for a change under `apps/studio`, `{"target_apps": ["web",
"studio"]}` for a change spanning both, `worker` for a change under `apps/worker`, `storage` for one
  under `packages/storage`, and `{"target_apps": []}` for a change to root files only
  (docs, `specs/`, `supabase/`, tooling). Commands then filter with `--filter=./apps/<name>`,
  repeated per target (see Build).

## Install

From the worktree root, in order. The main checkout is two directories up from `trees/<adw_id>/`.

1. Copy from the main checkout, each only if it exists there, preserving its path:
   `.env.development` at the root (ADW toolkit configuration), `apps/web/.env.development` (read
   by `next dev`) and `apps/web/.env.local` (read in every mode), `apps/studio/.env.development`
   (the studio's public Supabase URL and key) and `apps/worker/.env.development` (holds the local
   secret key the studio's test helpers read). Next reads env files from the app's folder, never
   from the repository root. None is required to build: both apps build and run with no variables.
   Never copy an `.env.example`; never invent a value for a missing file.
2. `yarn install --immutable` (every workspace; `postinstall` runs `lefthook install`). An install
   that would change `yarn.lock` is a finding, not something to paper over with a mutable install.
3. `yarn workspace @edit-issebya/web playwright install chromium webkit`, the browsers
   `@playwright/test` needs (WebKit runs only `apps/web/e2e/dialog_form.spec.ts`); the studio pins
   the same version, so this one install covers its chromium suite too. Browsers live in
   the user cache, so this is a no-op once present. On macOS 14 (Darwin below 24) the local WebKit
   build cannot open a page, so the WebKit server (`playwright run-server` in
   `mcr.microsoft.com/playwright:v1.64.0-noble`, container `pw-webkit-<adw_id>` on the run's
   `SERVICES_PORT`) is provided by `.adw/worktree-env`, which the engine runs with `up` before each
   phase and `down` when the worktree is reclaimed. Agents never start, stop, replace or probe that
   container, and never pick a port for it. Elsewhere (CI's Linux, macOS 15+) the hook prints
   nothing and local WebKit is used (see `app_docs/checkout.md`, "Form dialog layout").
4. Verify with `yarn build` (see Build).

Do not start the dev server during install.

## Build

- `yarn turbo run build --filter=./apps/web` for a change in the landing page,
  `--filter=./apps/studio` for one in the studio (both filters for both), `--filter=./apps/worker`
  and `--filter=./packages/storage` for those two; `yarn build` (the
  unfiltered `turbo run build`) for a root-only change or an unknown target. `--filter` takes the
  directory path, repeated per target workspace. Each app's build is `next build`; turbo caches
  `.next` in `.turbo/cache` (local to each worktree) and replays it when nothing it reads changed.
  The worker and the storage package have no build script (Node runs the TypeScript; Next
  transpiles the package), so their build check is typecheck; both typecheck with no variables.
- Needs no environment variables. Optional:
  `STRIPE_SECRET_KEY`, `STRIPE_AUTOMATIC_TAX`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
  `EMAIL_FROM`, `EMAIL_REPLY_TO`, `BOOKING_URL` (server), `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`,
  `NEXT_PUBLIC_POSTHOG_HOST` and `NEXT_PUBLIC_VERCEL_ENV` (set by Vercel, never by hand);
  `STUDIO_URL` and `STUDIO_PORT` (the landing page's forwarding target, read at build); for the
  studio `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
  `NEXT_PUBLIC_SITE_URL` (inlined at build). The studio builds with none of them; its `R2_*` and
  `E2E_MOCK_STORAGE` are read at run time, never needed to build. Turbo
  runs in strict env mode: a variable a task reads must be listed for that task in `turbo.json`.

## Tests

In the order the test phase runs them, all from the root (`<filter>` is `--filter=./apps/<name>`
per target, or nothing for a root-only change; the plain root scripts `yarn lint`,
`yarn typecheck`, `yarn test`, `yarn test:db`, `yarn build` and `yarn test:e2e` are the unfiltered
`turbo run` forms): lint
`yarn turbo run lint <filter>` (autofix `lint:fix`; each app's `eslint.config.mjs`); typecheck
`yarn turbo run typecheck <filter>` (`next typegen` then `tsc --noEmit` in each app; it rewrites
the gitignored `next-env.d.ts`, never stage it); dead code `yarn knip` (whole repository, one root
`knip.json` with a workspace per package); format `yarn format:check` (whole repository; write
`yarn format`); unit `yarn turbo run test <filter>` (vitest, database-free); DB integration
`yarn turbo run test:db --filter=./apps/studio` (after unit; needs the shared local stack); build
as in Build; and last the E2E suites `yarn test:e2e`.

The unit layer is `apps/web/src/**/*.test.ts` for pure helpers in `apps/web/src/lib/`, and
`apps/studio/src/**/*.test.ts` and `apps/studio/test-support/**/*.test.ts` for the studio's helpers
and the local-URL guard, `apps/worker/src/**/*.test.ts` for the worker's modules and
`packages/storage/src/**/*.test.ts` for the storage package. The DB layer is `apps/studio/db-tests/**/*.test.ts`
(`apps/studio/vitest.db.config.ts`: RLS on every public table, owner isolation, Realtime follows
RLS, and `jobs.test.ts` for `claim_job`'s lease), kept out of `yarn test` so the pre-push hook needs no database. There is no component test
layer; the browser layer is the Playwright suites below.

E2E code suites: `apps/web/e2e/*.spec.ts` (`@playwright/test`, chromium, plus webkit for the dialog
spec, `apps/web/playwright.config.ts`) and `apps/studio/e2e/*.spec.ts` (chromium,
`apps/studio/playwright.config.ts`, every spec through the landing page's address;
`upload.spec.ts` spawns the worker's `once`), run last by
the test phase as `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` (turbo passes `PORT`,
`STUDIO_PORT`, `CI`, `PW_*`, the mock flags and the Supabase variables through; extra Playwright
arguments go after `--`). On macOS 14 `PW_WEBKIT_WS` is already in the environment (set by
`.adw/worktree-env`) and is passed through as is; never set, unset or override it. On other machines
it is absent. turbo runs the studio suite after the landing suite, never both at once
(`@edit-issebya/studio#test:e2e` depends on `@edit-issebya/web#test:e2e`), so a run filtered to
`./apps/studio` also runs the landing suite first. The studio specs and `test:db` need the shared
local stack running (the owner keeps it up) and read the local secret key from
`apps/worker/.env.development`; a slice that adds a migration runs
`supabase migration up --local` before its local E2E. The `/prepare_app` server must already be up on this run's port, started with the
Workspaces dev command (an adopted server never sees `webServer.env`, and the checkout and
confirmation email specs need the mocks), which `reuseExistingServer` adopts; never set `CI=1` in a
run (it disables reuse and switches the server to `yarn start`). Specs run with `workers: 1`: they
share one server's mock state (Stripe capture and sessions, Resend recording) and its missing-key
and missing-config toggles. A user-visible change adds or extends a spec there.
Measure fixed or edge-aligned elements from the root box, never from `window.innerWidth`
(`scrollbar-gutter: stable` reserves 15px on Linux Chromium and none on macOS).

lefthook runs prettier, `yarn lint`, `yarn typecheck` and `yarn knip` on every commit and
`yarn test` on every push, all from the root (lint, typecheck and test through turbo).
`yarn test:e2e` and `yarn test:db` are in neither hook. Never bypass it. CI
(`.github/workflows/ci.yml`, job `check`) runs format check, lint, typecheck, knip, unit and build,
then starts its own fresh Supabase stack (which applies the migrations), exports its URL and keys
under allow-listed names (never Supabase's `STUDIO_URL`), builds again, and runs `test:db` and E2E,
on every pull request and push to `develop` and `master`.

## Ports

- No app is pinned to a port and nothing external holds a URL against one. The landing page's
  `next dev` honours `PORT` (turbo passes it through) and defaults to 3000; the studio's honours
  `STUDIO_PORT` and defaults to 3001. In a run `STUDIO_PORT` comes from the run's `BACKEND_PORT`.
- 54430 to 54439 belong to the one shared local Supabase stack (`supabase/config.toml`: API 54431,
  DB 54432) and never move.
- This run's port is in `.ports.env` at the worktree root (`PORT`, `BACKEND_PORT`, `FRONTEND_PORT`),
  written by the engine. Source it; never write, edit or delete it; fall back to 3000 only when it
  is absent. A server on 3000 when `PORT` is not 3000 is the developer's or an older run's: never
  reuse, probe, `lsof` or kill it.
- `SERVICES_PORT` in `.ports.env` (9300 + slot) belongs to this run's WebKit server from
  `.adw/worktree-env`; the same never-write rule as the other `.ports.env` values applies.

## Protected

- Never `npm`, `npx`, `pnpm` or `bun`. A new dependency goes to the workspace that uses it:
  `yarn workspace @edit-issebya/web add <pkg>` or `yarn workspace @edit-issebya/studio add <pkg>`,
  `yarn workspace @edit-issebya/worker add <pkg>` or `yarn workspace @edit-issebya/storage add <pkg>`
  (or `add -D`); `yarn add -D <pkg>` at the root only for shared tooling. Never install from inside
  a workspace folder.
- ADW runs exactly one database command on the shared local Supabase stack:
  `supabase migration up --local`, which applies only new migrations. It never runs
  `supabase db reset`, `supabase start`, `supabase stop`, a seed, or `supabase db push` to the
  hosted project. Every slice that adds a migration runs `supabase migration up --local` before its
  local E2E; if it fails, report the error and stop (do not reset). CI applies the migrations to
  its own fresh stack.
- One shared local Supabase stack on fixed ports 54430 to 54439; the owner starts it and runs stay
  serial. No test ever points at the hosted project (the test helpers refuse any host but
  `127.0.0.1` and `localhost`).
- `SUPABASE_SECRET_KEY` and the R2 worker keys (`R2_WORKER_ACCESS_KEY_ID`,
  `R2_WORKER_SECRET_ACCESS_KEY`) never appear in `apps/web` or in `apps/studio`'s app code
  (`src/`); only `apps/worker` and the test helpers under `apps/studio/test-support/` read them.
- Never start the worker (`worker`, `worker:prod`) in a run; only a spec spawns its `once`.
- Never touch `fixtures/footage/short-person.mp4`.
- Never pass `--no-verify`; never weaken a rule, a type or a test to make a check pass.
- Never kill a process this run did not start; never change a port through `package.json`,
  `.ports.env` or any committed file.
- Never stage `next-env.d.ts`, `.ports.env`, `.env*` (except the `.env.example` files),
  `.e2e-storage/`, `.turbo/`, `agents/` or `trees/`.
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
- Required trailer: none. The engine's `Deploy-Preview: yes` preview marker
  (`git_ops.PREVIEW_TRAILER`, appended by the document phase) is the only
  trailer that may appear; no command adds or strips it. `scripts/vercel-ignore.sh`,
  wired through each app's `vercel.json`, builds a Vercel preview on an ADW branch
  only for the commit that carries it.

## Review

- Open at `http://localhost:$PORT`: `/` (the one-screen landing page), `/` after clicking "Book
  your discovery call" (the form dialog open), and `/?checkout=success&session_id=cs_test_review`
  (the thank-you dialog). Capture each at 1920x1080, 375x667 and 320x568, nine captures,
  viewport-sized, not full page (the page must never scroll), into
  `agents/<adw_id>/<agent_name>/review_img/` in the worktree.
- Studio: `http://localhost:$PORT/studio` signed out (the login form), then signed in (the upload
  control above the reel list, then the `received` sample reel's page with its jobs and step log), each at 1920x1080 and 375x667. Sign in by opening the URL printed by
  `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url` (local secret key, refuses a
  non-local URL; creates `studio-review@example.test` with two sample reels when missing). The
  studio pages may scroll; the no-scroll rule is the landing page's.
- A helper in `apps/web/src/lib/` or `apps/studio/src/lib/` has no rendered surface: no visual review, evidence is the diff,
  the tests and the spec's commands.
- Browser automation is the Playwright MCP server in `.mcp.json`: the devDependency
  `@playwright/mcp` of the root `package.json`, pinned to exactly `0.0.81`, run from `node_modules`
  through `yarn playwright-mcp --isolated` at the root (no `yarn dlx`), configured by the root
  `playwright-mcp-config.json` (headless chromium, 1920x1080). An upgrade is a change to that pin.
