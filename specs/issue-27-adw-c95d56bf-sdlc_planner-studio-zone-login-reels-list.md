# Feature: reel studio skeleton, part 1 (/studio zone, magic-link login with RLS, reels list)

## Metadata

issue_number: `27`
adw_id: `c95d56bf`
issue_json: `{"number":27,"title":"feat: reel studio skeleton, part 1: /studio zone, magic-link login with RLS, reels list"}`

## Feature Description

The first half of the reel studio's skeleton (slice 4a of 17). It adds a second Next.js app,
`apps/studio` (`@edit-issebya/studio`), served at `edit.issebya.com/studio` through Next.js
multi-zones: the landing page (`apps/web`) forwards `/studio`, `/studio/:path+` and the studio's
asset prefix to the studio's own deployment. The studio has Supabase Auth with a magic link (one
account, the form never creates a user), a `reels` table protected by row-level security (RLS) and
published to Realtime, a reels list at `/studio` and a reel page shell at `/studio/reels/<id>`
that reads once and never polls.

It also lays the test foundations every later slice uses: an admin helper that refuses any
non-local Supabase URL, signing in from a spec without email (admin `generateLink` and the
studio's confirmation route), DB integration tests against the shared local stack (RLS on every
table, Realtime follows RLS), CI's own fresh Supabase stack, and the ADW profile for the studio
with the one database command ADW may run (`supabase migration up --local`).

## User Story

As the owner
I want to open edit.issebya.com/studio, log in with a link sent to my email, see my reels and open one to see its status
So that I have a private, database-backed home for my reels that every later slice (upload, worker, live status, export) builds on

## Problem Statement

The repository has only the landing page. `apps/studio` and `apps/worker` hold only `.env.example`,
there is no `supabase/migrations/`, no way to sign in, no table for reels, and no test
infrastructure that can talk to a database safely. Every later studio slice needs a zone at
`/studio`, an owner-scoped data model enforced by the database, a way to sign in from a spec, and a
guard that keeps tests away from the hosted project. CI has no database at all.

## Solution Statement

- A new Next 16.3.8 workspace `apps/studio` with `basePath: "/studio"` and
  `assetPrefix: "/studio-static"`, mirroring `apps/web`'s tooling (ESLint flat config, Tailwind 4,
  vitest, Playwright). Supabase clients are created per request through `@supabase/ssr` (server
  components, server actions, the confirmation route handler and `src/proxy.ts`), never at module
  load, so `yarn build` passes with no variables.
- `apps/web/next.config.ts` gains `rewrites()` to `STUDIO_URL` or
  `http://localhost:${STUDIO_PORT || 3001}`, computed by a small pure helper with a unit test.
- One migration `supabase/migrations/<timestamp>_studio_skeleton.sql` creates `public.reels` with
  RLS on, one `select` policy for the owner (`authenticated`), no write policies, no `anon` grants,
  an `updated_at` trigger, and adds the table to `supabase_realtime`.
- Login: a server action calls `signInWithOtp({ shouldCreateUser: false, emailRedirectTo })` and
  always answers with the same neutral message; `/studio/auth/confirm` calls `verifyOtp` with
  `token_hash` and `type`, sets the session cookie and redirects (relative `Location`) to `/studio`.
  A logout server action signs out.
- Test helpers outside the bundled app code (`apps/studio/test-support/`): `localSupabaseAdmin()`
  (throws unless the host is `127.0.0.1` or `localhost`), `signInLink()` (admin `generateLink` to
  a confirmation URL), user and reel factories. A separate vitest config and script `test:db` holds
  the DB integration tests so the pre-push `yarn test` stays database-free. Studio specs run through
  the landing page's address.
- CI starts a fresh Supabase stack (auth, realtime, kong, postgrest, db only), exports only the
  allow-listed variables under new names (never `STUDIO_URL`), rebuilds with them, runs `test:db`
  and the E2E suites.
- `.adw/project.md`, `app_docs/studio.md`, `docs/conditional-docs.md` and the root `README.md` are
  updated in the same change.

## Relevant Files

Use these files to implement the feature:

- `README.md`: root run instructions; gains "Run the studio locally" (run instructions only).
- `AGENTS.md`: working rules (Yarn only, strict turbo env, no em-dashes, `.env*` never read or
  committed, `.adw/project.md` headings never renamed, one doc per feature, root-box measuring).
- `docs/conditional-docs.md`: documentation index; gains one line for `app_docs/studio.md`.
- `.adw/project.md`: the ADW profile; updated under its nine existing headings (Identity,
  Workspaces, Install, Build, Tests, Ports, Protected, Documentation file names only, Review). Never
  touch the "Required trailer" line.
- `/Users/sveta/Dev/issebya/issebya-homes-ai-system/.adw/project.md`: read-only pattern for a
  profile with a shared local Supabase stack (its Tests and Protected sections).
- `app_docs/checkout.md` ("E2E Stripe mock") and `apps/web/src/instrumentation.ts`: the opt-in,
  exactly-`"true"` mock pattern (nothing in this issue adds a mock, but the doc style and flag
  conventions are reused in `app_docs/studio.md`).
- `app_docs/landing-page.md`: the landing page invariants; its specs must pass unchanged (the
  only landing change is the forwarding).
- `apps/web/next.config.ts`: gains `rewrites()`; keep `redirects()`, `turbopack.root`,
  `outputFileTracingRoot`, `agentRules: false`, `reactStrictMode`.
- `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/eslint.config.mjs`,
  `apps/web/postcss.config.mjs`, `apps/web/vitest.config.ts`, `apps/web/playwright.config.ts`,
  `apps/web/vercel.json`, `apps/web/README.md`, `apps/web/src/app/globals.css`,
  `apps/web/src/app/layout.tsx`: the templates the studio copies (same versions, same lint rules,
  same `workers: 1`, `retries: 0`, `reuseExistingServer: !process.env.CI` conventions).
- `apps/web/src/lib/short-links.ts` and its test: the pattern for a pure config helper imported by
  `next.config.ts` with a unit test.
- `apps/web/.env.example`: already declares `STUDIO_URL` and `STUDIO_PORT`; comments stay true.
- `apps/studio/.env.example`, `apps/worker/.env.example`: exact variable names; do not rename or
  remove any; keep comments true.
- `supabase/config.toml`: local stack ports (API 54431, DB 54432); gains the optional
  `[auth.email.template.magic_link]` section.
- `turbo.json`: strict env; gains `STUDIO_URL`, `STUDIO_PORT`, `SUPABASE_*`,
  `NEXT_PUBLIC_SUPABASE_*` where tasks read them, a `test:db` task and the studio E2E ordering.
- `knip.json`: gains the `apps/studio` workspace.
- `lefthook.yml`: unchanged (pre-push stays `yarn test`, which stays DB-free).
- `.github/workflows/ci.yml`: gains the Supabase stack, the env export, a second build, `test:db`
  and the studio's Playwright install.
- `package.json` (root): gains `test:db` (`turbo run test:db`).
- `scripts/vercel-ignore.sh`: exists; the studio's `vercel.json` points at it.
- Next docs (read before writing code):
  `node_modules/next/dist/docs/01-app/02-guides/multi-zones.md`,
  `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/basePath.md`,
  `.../assetPrefix.md`, `.../serverActions.md` (allowedOrigins: host only, no port wildcard;
  Next's external rewrite proxy sets `x-forwarded-host` to the landing host, see
  `node_modules/next/dist/server/lib/router-utils/proxy-request.js`, so same-origin checks pass
  through the landing page), `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
  (Next 16: `proxy.ts`, named export `proxy`, `config.matcher`).

### New Files

- `apps/studio/package.json`: `@edit-issebya/studio`, scripts `dev`
  (`next dev -p ${STUDIO_PORT:-3001}`), `build`, `start` (`next start -p ${STUDIO_PORT:-3001}`),
  `typecheck` (`next typegen && tsc --noEmit`), `lint`, `lint:fix`, `test` (`vitest run`),
  `test:db` (`vitest run --config vitest.db.config.ts`), `test:e2e` (`playwright test`),
  `e2e:sign-in-url` (`node --env-file-if-exists=../worker/.env.development --env-file-if-exists=.env.development scripts/e2e-sign-in-url.ts`).
- `apps/studio/next.config.ts`: `basePath`, `assetPrefix`, `turbopack.root`,
  `outputFileTracingRoot`, `agentRules: false`, `reactStrictMode: true`,
  `experimental.serverActions.allowedOrigins` derived from `NEXT_PUBLIC_SITE_URL`'s host when set.
- `apps/studio/tsconfig.json`, `apps/studio/eslint.config.mjs`, `apps/studio/postcss.config.mjs`:
  copies of the web ones (eslint also ignores nothing new; `no-secrets` stays on).
- `apps/studio/vitest.config.ts`: unit tests `src/**/*.test.ts` and `test-support/**/*.test.ts`.
- `apps/studio/vitest.db.config.ts`: DB integration tests `db-tests/**/*.test.ts`, loads
  `../worker/.env.development` and `.env.development` with `process.loadEnvFile` when present (never
  overriding variables already set), `fileParallelism: false`, `testTimeout: 20_000`.
- `apps/studio/playwright.config.ts`: `testDir: ./e2e`, chromium only, `workers: 1`, `retries: 0`,
  `baseURL` `http://localhost:${PORT ?? 3000}`, two `webServer` entries (studio and web), same env
  file loading as the db config.
- `apps/studio/vercel.json`: `{"$schema": "https://openapi.vercel.sh/vercel.json", "ignoreCommand": "bash ../../scripts/vercel-ignore.sh"}`.
- `apps/studio/README.md`: one line naming the workspace (the reel studio, served at `/studio`),
  links to the root README, `docs/conditional-docs.md` and `AGENTS.md`.
- `apps/studio/src/app/layout.tsx`, `apps/studio/src/app/globals.css`: root layout (title
  "Studio", `robots: { index: false }`), Tailwind import.
- `apps/studio/src/app/page.tsx`: signed out shows the login form, signed in shows the reels list
  and the logout control; missing config shows a short "not configured" notice.
- `apps/studio/src/app/actions.ts`: `sendMagicLink` and `signOut` server actions.
- `apps/studio/src/app/auth/confirm/route.ts`: the confirmation route handler.
- `apps/studio/src/app/reels/[id]/page.tsx`: the reel page (reads once).
- `apps/studio/src/app/not-found.tsx`: the studio's not-found page.
- `apps/studio/src/components/LoginForm.tsx` (client, `useActionState`), `ReelList.tsx`,
  `SignOutButton.tsx`.
- `apps/studio/src/proxy.ts`: session refresh on every page request.
- `apps/studio/src/lib/supabase-config.ts` (+ `.test.ts`): reads the two public variables, returns
  `null` when either is empty.
- `apps/studio/src/lib/supabase-server.ts`: `createSupabaseServerClient()` per request with
  `cookies()` from `next/headers`.
- `apps/studio/src/lib/confirm-url.ts` (+ `.test.ts`): builds `<origin>/studio/auth/confirm`
  from `NEXT_PUBLIC_SITE_URL`, else from `x-forwarded-proto`/`x-forwarded-host`/`host`.
- `apps/studio/src/lib/reels.ts` (+ `.test.ts`): `REEL_COLUMNS` (named columns), `isReelId`
  (uuid check), `REEL_STATUSES`, `formatCreatedAt`.
- `apps/studio/test-support/local-supabase.ts` (+ `.test.ts`): `assertLocalUrl`,
  `localSupabaseAdmin`, `LOCAL_DB_URL` (`postgresql://postgres:postgres@127.0.0.1:54432/postgres`).
- `apps/studio/test-support/fixtures.ts`: `createTestUser`, `deleteTestUser`, `insertReel`,
  `signInLink`, `signedInClient` (publishable-key client with a verified session).
- `apps/studio/db-tests/rls.test.ts`, `apps/studio/db-tests/realtime.test.ts`: Verification 2 and 3.
- `apps/studio/e2e/login.spec.ts`, `apps/studio/e2e/reels.spec.ts`,
  `apps/studio/e2e/forwarding.spec.ts`: Verification 4 to 7.
- `apps/studio/scripts/e2e-sign-in-url.ts`: prints a confirmation URL for the test user (local only).
- `apps/web/src/lib/studio-rewrites.ts` (+ `.test.ts`): `studioOrigin(env)` and
  `studioRewrites(origin)`.
- `supabase/migrations/<timestamp>_studio_skeleton.sql`: the `reels` table, RLS, policy, grants,
  trigger, Realtime publication.
- `supabase/templates/magic-link.html`: optional local token-hash email template.
- `app_docs/studio.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Create the `apps/studio` workspace with the same tooling as `apps/web`, add the dependencies, wire
it into turbo, knip and the root scripts, and prove that `yarn build`, `yarn lint`,
`yarn typecheck` and `yarn knip` pass with an empty studio page. Write the migration and apply it
with `supabase migration up --local` (stop and report on failure, never reset). Add the forwarding
in `apps/web/next.config.ts` through a unit-tested helper.

### Phase 2: Core Implementation

Supabase SSR clients created per request, the session-refresh proxy, the login form and server
action, the confirmation route, logout, the reels list and the reel page. Test helpers with the
local-URL guard, the DB integration tests (RLS on every table, owner isolation, no writes through
`authenticated`, Realtime follows RLS), and the studio E2E specs through the landing page's address.

### Phase 3: Integration

CI's own Supabase stack and env export, the ADW profile, the sign-in script for reviewers, the
feature doc, the documentation index and the root README. Run every gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before writing

- Read `node_modules/next/dist/docs/01-app/02-guides/multi-zones.md`, `basePath.md`,
  `assetPrefix.md`, `serverActions.md` and `03-file-conventions/proxy.md` (paths under Relevant
  Files). Confirm: in Next 15+ a zone serves its own `assetPrefix` path with no extra rewrite;
  `proxy.ts` sits in `src/` beside `app/`, exports `proxy`, and its `matcher` is written without
  the `basePath` (verify against the doc; adjust if it says otherwise).
- Read `app_docs/landing-page.md` and `app_docs/checkout.md` Rules so the landing change breaks no
  invariant.

### 2. Scaffold `apps/studio`

- Create `apps/studio/package.json` (name `@edit-issebya/studio`, `private`, `engines.node`
  `24.x`, scripts listed under New Files). Copy `tsconfig.json`, `postcss.config.mjs`,
  `eslint.config.mjs` from `apps/web` (adjust the header comment to say it mirrors web's).
- Add dependencies with the profile's command, from the repository root:
  - `yarn workspace @edit-issebya/studio add next@16.3.8 react@19.3.0 react-dom@19.3.0 @supabase/ssr @supabase/supabase-js`
  - `yarn workspace @edit-issebya/studio add -D @playwright/test@1.64.0 @tailwindcss/postcss@^4 tailwindcss@^4 @types/node@^24 @types/react@^19 @types/react-dom@^19 eslint@^9 eslint-config-next@16.3.8 eslint-config-prettier@^10.1.8 eslint-plugin-no-secrets@^2.3.3 eslint-plugin-security@^4.2.0 typescript@5.9.3 vite@^8.3.2 vitest@^5.0.3 pg @types/pg`
- `apps/studio/next.config.ts`:
  - `const monorepoRoot = join(import.meta.dirname, "..", "..")`; `turbopack.root` and
    `outputFileTracingRoot` set to it (same comment as web).
  - `basePath: "/studio"`, `assetPrefix: "/studio-static"`, `agentRules: false`,
    `reactStrictMode: true`.
  - `experimental.serverActions.allowedOrigins`: the host of `NEXT_PUBLIC_SITE_URL` when it parses
    (for production behind a proxy that does not forward the host), else omitted. Comment that
    through the landing page Next's rewrite proxy sends `x-forwarded-host`, so dev and ADW runs on
    any port need no entry (ports cannot be wildcarded).
- `apps/studio/vercel.json` exactly as under New Files. `scripts/vercel-ignore.sh` exists on this
  branch, so no PR note is needed (still say in the PR that the file mirrors web's).
- `apps/studio/README.md` as under New Files.
- `apps/studio/src/app/layout.tsx` and `globals.css` (Tailwind import, a plain neutral style; no
  landing fonts or brand needed) and a placeholder `page.tsx`.
- `apps/studio/vitest.config.ts` (alias `@` to `./src`, include `src/**/*.test.ts` and
  `test-support/**/*.test.ts`).
- Ensure `.gitignore` already covers `apps/studio/.next`, `next-env.d.ts`, `playwright-report`,
  `test-results`, `.env*` (check the root `.gitignore`; extend only if a path is missing).

### 3. Repository wiring

- Root `package.json`: add `"test:db": "turbo run test:db"`.
- `turbo.json`:
  - `build.env`: add `STUDIO_URL`, `STUDIO_PORT` (web's rewrites are computed at build time).
    `NEXT_PUBLIC_*` already covers the studio's public variables.
  - `dev.passThroughEnv` and `start.passThroughEnv`: add `STUDIO_URL`, `STUDIO_PORT`.
  - `test:e2e.passThroughEnv`: add `STUDIO_URL`, `STUDIO_PORT`, `SUPABASE_URL`,
    `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_*`, `NEXT_PUBLIC_SITE_URL`.
  - New task `test:db`: `cache: false`, `outputs: []`, `passThroughEnv`: `SUPABASE_URL`,
    `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_*`.
  - New task `@edit-issebya/studio#test:e2e`: same keys as `test:e2e` plus
    `dependsOn: ["@edit-issebya/web#test:e2e"]`, so turbo never runs the two Playwright suites at
    once (both start or adopt the landing server on `PORT`; in CI both would bind it). Verify with
    `yarn turbo run test:e2e --dry` that the order holds; if a filtered run (`--filter=./apps/studio`)
    then also runs web's suite, accept it and say so in the profile.
- `knip.json`: add workspace `apps/studio` with `next: true`, `vitest: { config: ["vitest.config.ts", "vitest.db.config.ts"] }`,
  `playwright: true`, `entry: ["scripts/*.ts"]`, `project: ["src/**/*.{ts,tsx,css}", "e2e/**/*.ts", "db-tests/**/*.ts", "test-support/**/*.ts", "scripts/**/*.ts"]`.
  Adjust to what knip 6 actually needs until `yarn knip` is clean without ignores that hide real
  findings.
- Run `yarn install` once after the adds (it updates `yarn.lock`, expected in this change), then
  `yarn build`, `yarn lint`, `yarn typecheck`, `yarn knip` with the placeholder page.

### 4. Forwarding in `apps/web`

- `apps/web/src/lib/studio-rewrites.ts`:
  - `STUDIO_ASSET_PREFIX = "/studio-static"` with a comment that it must equal the studio's
    `assetPrefix`.
  - `studioOrigin(env: { STUDIO_URL?: string; STUDIO_PORT?: string }): string`: `STUDIO_URL`
    trimmed without a trailing slash when non-empty, else `http://localhost:${STUDIO_PORT || 3001}`.
  - `studioRewrites(origin)`: `[{ source: "/studio", destination: `${origin}/studio`},
{ source: "/studio/:path+", destination:`${origin}/studio/:path+`},
{ source: "/studio-static/:path+", destination:`${origin}/studio-static/:path+` }]`.
- `apps/web/src/lib/studio-rewrites.test.ts`: empty env gives `http://localhost:3001`;
  `STUDIO_PORT=9106` gives 9106; `STUDIO_URL` wins over the port and loses its trailing slash; the
  three rules have the expected sources and destinations.
- `apps/web/next.config.ts`: add `rewrites() { return studioRewrites(studioOrigin(process.env)); }`
  with a comment pointing at `app_docs/studio.md`, "Zone and forwarding". Keep everything else.

### 5. Database migration

- Create `supabase/migrations/<UTC timestamp>_studio_skeleton.sql` (timestamp `YYYYMMDDHHMMSS`):
  - `create table public.reels (id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade, status text not null default 'uploading' check (status in ('uploading','uploaded','received','failed')), source_key text, source_bytes bigint check (source_bytes >= 0), source_name text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`
    (`on delete cascade` lets test cleanup delete a test user with their reels.)
  - `create index reels_owner_created_idx on public.reels (owner_id, created_at desc);`
  - `public.set_updated_at()` trigger function (`language plpgsql`, `set search_path = ''`) and a
    `before update` trigger on `reels`.
  - `alter table public.reels enable row level security;`
  - `revoke all on public.reels from anon;` and `revoke insert, update, delete on public.reels from authenticated;`
    (defence in depth beside RLS; `grant select on public.reels to authenticated;` explicitly).
  - `create policy "reels: owner selects own" on public.reels for select to authenticated using ((select auth.uid()) = owner_id);`
  - `alter publication supabase_realtime add table public.reels;`
- Optional email template: `supabase/templates/magic-link.html` with a link to
  `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` and in `supabase/config.toml`
  `[auth.email.template.magic_link]` with `subject` and `content_path = "./supabase/templates/magic-link.html"`.
  Supabase only honours `RedirectTo` when it is on the redirect allow-list (otherwise it falls back
  to `site_url`), so the template helps only for allowed addresses; it takes effect after the owner
  restarts the stack and no spec depends on it.
- Apply it: `supabase migration up --local`. If it fails, report the error and stop; never run
  `supabase db reset`, `start`, `stop`, a seed or `db push`.

### 6. Supabase clients and session refresh

- `src/lib/supabase-config.ts`: `supabaseConfig(env = process.env)` returns
  `{ url, publishableKey }` or `null` when either `NEXT_PUBLIC_SUPABASE_URL` or
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is empty. Read with literal `process.env.NEXT_PUBLIC_...`
  property access so Next inlines them. Test: both set, one missing, both empty.
- `src/lib/supabase-server.ts`: `createSupabaseServerClient()` (async, `await cookies()`),
  `createServerClient` from `@supabase/ssr` with `getAll`/`setAll` (try/catch in `setAll` for server
  components). Returns `null` when the config is `null`. Never at module load.
- `src/proxy.ts`: the `@supabase/ssr` session-refresh pattern (create a client against the request
  and response cookies, call `supabase.auth.getClaims()` (or `getUser()`), return the response with
  refreshed cookies). Pass through untouched when the config is `null`. `config.matcher` excludes
  `_next/static`, `_next/image`, favicon and image files.

### 7. Login, confirmation and logout

- `src/lib/confirm-url.ts`: `confirmUrl({ siteUrl, forwardedProto, forwardedHost, host })`
  returns `${origin}/studio/auth/confirm`, origin from `siteUrl` (trailing slash stripped) when set,
  else `${forwardedProto ?? "http"}://${forwardedHost ?? host}`. Test the three sources.
  (`NEXT_PUBLIC_SITE_URL` is the issue's choice; the forwarded-host fallback keeps per-run ports
  correct when it is empty, which is also why CI never sets it: the landing page reads the same
  variable for `metadataBase`.)
- `src/app/actions.ts`:
  - `sendMagicLink(prev, formData)`: validate the email (simple shape check), create the server
    client, call `auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: confirmUrl(...) } })`.
    Whatever the outcome for a well-formed email (sent, unknown user, rate-limited), return the same
    `{ status: "sent" }` message ("If this address has an account, a sign-in link is on its way.");
    log the error server-side without the address. Invalid email returns a field error. Missing
    config returns `{ status: "unavailable" }`.
  - `signOut()`: `auth.signOut()` then `redirect("/")` (basePath-relative, lands on `/studio`).
- `src/components/LoginForm.tsx` (client): `useActionState(sendMagicLink, ...)`, a labelled email
  input, a submit button, an `aria-live="polite"` status line. Accessible names: label "Email",
  button "Send sign-in link".
- `src/app/auth/confirm/route.ts` `GET`: read `token_hash` and `type` (accept `email` and
  `magiclink`); on a missing value or a `verifyOtp` error, redirect to `/studio?error=link` ; on
  success redirect to `/studio`. Always a relative `Location` (never `request.url`'s origin, which is
  the studio's internal host behind the rewrite). Use Next's `redirect()` or a `NextResponse` with
  a relative location, whichever keeps the cookies set through `cookies()` on the response; the
  login spec proves the cookie lands on the landing address.
- `/studio?error=link` shows "That sign-in link has expired or was already used." above the form.
- `src/components/SignOutButton.tsx`: a form posting to `signOut`, button "Log out".

### 8. Studio pages

- `src/lib/reels.ts`: `REEL_COLUMNS = "id, status, source_name, created_at"` and
  `REEL_DETAIL_COLUMNS = "id, status, source_name, source_bytes, created_at, updated_at"` (B3 rule
  1: named columns, never `*`), `isReelId(id)` (uuid regex, a literal so
  `security/detect-non-literal-regexp` is happy and not unsafe), `formatCreatedAt(iso)` with
  `Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })`,
  and a `reelName(reel)` fallback ("Untitled reel") for a null `source_name`. Tests for each.
- `src/app/page.tsx` (dynamic, server component): no config shows the notice; no session
  (`auth.getUser()` or `getClaims()`) shows `LoginForm`; signed in shows a header with the account
  email and `SignOutButton`, then `ReelList` from one query
  `.from("reels").select(REEL_COLUMNS).order("created_at", { ascending: false })`. RLS does the
  owner filtering; do not add a client-side owner filter that would mask a missing policy.
- `src/components/ReelList.tsx`: a `<ul aria-label="Reels">`, each item a `next/link` to
  `/reels/<id>` (same zone, basePath applies) with name, status and created time. Empty list:
  "No reels yet.".
- `src/app/reels/[id]/page.tsx`: `await params`; not a uuid calls `notFound()`; signed out
  redirects to `/`; one `.select(REEL_DETAIL_COLUMNS).eq("id", id).maybeSingle()`; null calls
  `notFound()`. Shows the name as `h1`, the status (`data-testid="reel-status"`), size and created
  time, and a link back to the list. No polling, no interval, no client fetch (B3 rule 2).
- `src/app/not-found.tsx`: "Reel not found" heading and a link back to `/studio`'s list.

### 9. Test helpers

- `test-support/local-supabase.ts`:
  - `assertLocalUrl(url)`: parse with `new URL`; throw `Error("Refusing non-local Supabase URL ...")`
    unless `hostname` is `127.0.0.1` or `localhost`; also throw on an unparsable or empty URL.
  - `localSupabaseAdmin(env = process.env)`: requires `SUPABASE_URL` and `SUPABASE_SECRET_KEY`
    (clear error naming `apps/worker/.env.development` when missing), asserts the URL, returns
    `createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })`.
  - `LOCAL_DB_URL` constant (the local stack's default credentials; asserted local by construction).
- `test-support/local-supabase.test.ts` (unit, runs in `yarn test`, no network):
  `localSupabaseAdmin({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "k" })` throws;
  `http://127.0.0.1:54431` and `http://localhost:54431` return a client; a missing key throws;
  `https://127.0.0.1.evil.example` throws.
- `test-support/fixtures.ts`:
  - `createTestUser(admin, label)`: email `studio-${label}-${crypto.randomUUID()}@example.test`,
    `auth.admin.createUser({ email, email_confirm: true })`.
  - `deleteTestUser(admin, id)` (cascade removes the reels).
  - `insertReel(admin, { ownerId, name, status, createdAt })` (admin bypasses RLS; `createdAt`
    lets specs fix the order deterministically).
  - `signInLink(admin, email, baseUrl)`: `auth.admin.generateLink({ type: "magiclink", email })`,
    returns `${baseUrl}/studio/auth/confirm?token_hash=${properties.hashed_token}&type=email`.
  - `signedInClient(admin, email)`: publishable-key client (URL asserted local) that calls
    `auth.verifyOtp({ token_hash, type: "email" })` and returns the client with the session.
- These files never import from `src/app` and nothing under `src/` imports them, so the secret key
  never enters the bundle. Add an ESLint `no-restricted-imports` rule in `apps/studio/eslint.config.mjs`
  for files under `src/**` forbidding `**/test-support/**` (cheap guard for the secret-key rule).

### 10. DB integration tests (`yarn turbo run test:db --filter=./apps/studio`)

- `apps/studio/vitest.db.config.ts` as under New Files.
- `db-tests/rls.test.ts` (uses `pg` against `LOCAL_DB_URL` and supabase-js clients):
  - Every table in `public` has `relrowsecurity` true and at least one row in `pg_policies`
    (query `pg_class` join `pg_namespace` where `nspname = 'public' and relkind = 'r'`); the list is
    non-empty and contains `reels` (so the check is not vacuous). This guards every later migration.
  - Users A and B, a reel for A inserted by the admin. B's `select ... eq("id", reelA)` returns zero
    rows; A's returns one.
  - A's insert errors (RLS/permission); A's update and delete affect nothing: re-read with the
    admin and assert the row and its status are unchanged.
  - An anon client (publishable key, no session) gets no rows or a permission error.
  - `afterAll` deletes both users.
- `db-tests/realtime.test.ts`: A and B each `channel(...).on("postgres_changes", { event: "UPDATE", schema: "public", table: "reels", filter: `id=eq.${reelA}` }, ...)`
  after `realtime.setAuth(session.access_token)`; wait until both report `SUBSCRIBED`; the admin
  updates A's reel status; assert A receives the event within 5 s and B received nothing over the
  same 5 s window (wait the full window after A's arrival). Remove channels and users afterwards.
- Run it locally against the shared stack (after `supabase migration up --local`).

### 11. E2E specs (studio)

- `apps/studio/playwright.config.ts`:
  - Load `../worker/.env.development` and `.env.development` with `process.loadEnvFile` when they
    exist (do not override set variables).
  - `PORT = process.env.PORT ?? "3000"`, `STUDIO_PORT = process.env.STUDIO_PORT ?? "3001"`,
    `baseURL` `http://localhost:${PORT}`.
  - `webServer`: `[{ command: CI ? "yarn workspace @edit-issebya/studio start" : "yarn workspace @edit-issebya/studio dev", url: `http://localhost:${STUDIO_PORT}/studio`, env: { STUDIO_PORT } }, { command: CI ? "yarn workspace @edit-issebya/web start" : "yarn workspace @edit-issebya/web dev", url: `http://localhost:${PORT}`, env: { PORT, STUDIO_PORT } }]`,
both `reuseExistingServer: !process.env.CI`, `timeout: 120_000`, graceful SIGTERM. Never set
`CI=1` in a run.
  - `workers: 1`, `retries: 0`, `forbidOnly: !!process.env.CI`, chromium at 1920x1080.
- `e2e/login.spec.ts` (Verification 4 and 5):
  - Signed out, `/studio` shows the email field and "Send sign-in link"; submit
    `unknown-${uuid}@example.test`; the neutral message appears; the admin API finds no user with
    that email (`auth.admin.listUsers` and search).
  - Create a test user, open `signInLink(admin, email, baseURL)`; the page lands on
    `http://localhost:${PORT}/studio` (assert the URL's port is `PORT`, proving the redirect stayed
    on the landing address) and shows the reels list region and "Log out"; clicking it returns to
    the form. An already used link shows the expired-link message.
- `e2e/reels.spec.ts` (Verification 6): two reels for the test user (older and newer
  `createdAt`, distinct names and statuses) and one for another user; sign in; the list shows
  exactly the two, newer first, not the other user's; open the first, see its name and
  `reel-status`; `page.goto("/studio/reels/<other user's reel id>")` shows "Reel not found"; a
  non-uuid id also shows it. Clean up users in `afterAll`.
- `e2e/forwarding.spec.ts` (Verification 7): `request.get("/studio")` is 200 and its HTML contains
  `/studio-static/_next/`; extract one such asset URL from the HTML and `request.get` it through
  the landing address: 200. Signed-out page shows the form (proves the response is the studio, not
  Supabase Studio).
- The landing page's specs under `apps/web/e2e/` are not changed.

### 12. CI (`.github/workflows/ci.yml`)

- Keep the existing steps through `yarn build` (that build runs with no studio variables, proving
  the gate).
- Then:
  - `- uses: supabase/setup-cli@v3` with `version: 2.75.0`.
  - `- run: supabase start -x storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`
    (keeps gotrue, realtime, kong, postgrest and the database; applies the migrations to the fresh
    CI-only stack). If the CLI refuses to exclude mailpit while `[inbucket]` is enabled, keep mailpit
    running rather than editing the shared config.
  - Export only what tests need, by allow-list and under new names, so `STUDIO_URL` from
    `supabase status -o env` never reaches the environment:
    ```
    - name: Export local Supabase values
      run: |
        eval "$(supabase status -o env | grep -E '^(API_URL|PUBLISHABLE_KEY|SECRET_KEY)=')"
        {
          echo "SUPABASE_URL=$API_URL"
          echo "SUPABASE_SECRET_KEY=$SECRET_KEY"
          echo "NEXT_PUBLIC_SUPABASE_URL=$API_URL"
          echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY"
        } >> "$GITHUB_ENV"
    ```
    (Add `echo "::add-mask::$SECRET_KEY"` before writing it.) Never `NEXT_PUBLIC_SITE_URL`.
  - `- run: yarn build` again (turbo rehashes on `NEXT_PUBLIC_*`, so the studio is rebuilt with the
    inlined public values; the landing page is rebuilt identically apart from the hash).
  - `- run: yarn test:db`.
  - Playwright install for both workspaces (`yarn workspace @edit-issebya/web playwright install --with-deps chromium webkit`
    already installs into the shared cache; the studio uses the same `@playwright/test` version so no
    second install is needed; verify).
  - `- run: yarn test:e2e`.
- CI never references the hosted project.

### 13. Sign-in script for reviewers

- `apps/studio/scripts/e2e-sign-in-url.ts` (Node 24 runs `.ts` with type stripping; import the
  helpers with explicit `.ts` extensions): reads `PORT` (default 3000), the admin helper (which
  refuses a non-local URL), creates or reuses `studio-review@example.test`, inserts two sample reels
  for it when it has none, prints the confirmation URL and nothing else.
- Run `yarn workspace @edit-issebya/studio e2e:sign-in-url` once locally to check it.

### 14. ADW profile (`.adw/project.md`)

Add facts under the existing nine headings; never rename or reorder them.

- **Identity:** two workspaces, `apps/web` (`@edit-issebya/web`) and `apps/studio`
  (`@edit-issebya/studio`, the reel studio at `/studio` through multi-zones; `apps/worker` arrives
  with #43); the shared local Supabase stack (`supabase/config.toml`, ports 54430 to 54439).
- **Workspaces:** web row dev command becomes
  `set -a; . ./.ports.env; set +a; STUDIO_PORT=$BACKEND_PORT E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn turbo run dev --filter=./apps/web --filter=./apps/studio`
  (state that `.ports.env` is sourced first); add a `studio` row: path `apps/studio`, dev command
  "started with web", port variable `STUDIO_PORT`, default 3001, health URL `/studio`, ADW may
  start `no`. Note `FRONTEND_PORT` equals `PORT` and is never used for the studio; the studio's `dev`
  is `next dev -p ${STUDIO_PORT:-3001}`; update the `target_apps` bullet (`studio` for a change
  under `apps/studio`, both for a change spanning them) and the filter line.
- **Install:** also copy `apps/studio/.env.development` and `apps/worker/.env.development` when
  present (the worker file holds the local secret key the test helpers read); never copy an
  `.env.example`, never invent a value. Playwright install covers the studio (same version).
- **Build:** `--filter=./apps/studio`; the studio builds with no variables.
- **Tests:** add the studio's unit tests (`apps/studio/src/**/*.test.ts`,
  `apps/studio/test-support/**/*.test.ts`), the DB layer `yarn turbo run test:db --filter=./apps/studio`
  (needs the shared local stack, run after unit), the studio E2E suite `apps/studio/e2e/*.spec.ts`
  through the landing address; the E2E command becomes
  `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`; studio specs and `test:db` need the
  shared local stack running (the owner keeps it up); a slice that adds a migration runs
  `supabase migration up --local` before its local E2E. Update the CI sentence (CI starts its own
  stack and runs `test:db`).
- **Ports:** `STUDIO_PORT` comes from the run's `BACKEND_PORT`; 54430 to 54439 belong to the one
  shared local Supabase stack and never move. Replace "Nothing in this repository is pinned to a
  port" accordingly.
- **Protected:** add the migration rule verbatim: "ADW runs exactly one database command on the
  shared local Supabase stack: `supabase migration up --local`, which applies only new migrations.
  It never runs `supabase db reset`, `supabase start`, `supabase stop`, a seed, or `supabase db push`
  to the hosted project. Every slice that adds a migration runs `supabase migration up --local`
  before its local E2E; if it fails, report the error and stop (do not reset). CI applies the
  migrations to its own fresh stack." Plus: one shared local stack on fixed ports 54430 to 54439, the
  owner starts it, runs stay serial; no test ever points at the hosted project;
  `SUPABASE_SECRET_KEY` never appears in `apps/web` or in `apps/studio`'s app code; the dependency
  command example names both workspaces. (There is no existing line forbidding migrations to replace;
  check again before editing.)
- **Documentation:** only file names if any change. Do not touch the "Required trailer" line.
- **Review:** add `http://localhost:$PORT/studio` signed out (the login form) and signed in (the
  reel list, then one reel's page) at 1920x1080 and 375x667; sign in by opening the URL printed by
  `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url` (local secret key, refuses a
  non-local URL). The studio pages may scroll (the no-scroll rule is the landing page's).

### 15. Docs

- `app_docs/studio.md`: sections "Zone and forwarding" (basePath, assetPrefix, the rewrites and
  `STUDIO_URL`/`STUDIO_PORT`, plain `<a>` for cross-zone links), "Login" (magic link, one account,
  `shouldCreateUser: false`, the confirmation route and why it lives on the studio's own route, the
  neutral message, logout, local email rate limit of 2 per hour in `config.toml`), "Data" (the
  `reels` table, RLS policy, no write policies, no anon, Realtime publication, named columns),
  "No polling", "Local stack and test helpers" (`localSupabaseAdmin`, `signInLink`, `test:db`,
  `@example.test`, env files), "Migrations" (the one command), "CI stack", and "Rules" with the
  constraints as never-rules: never point a test at the hosted project; never put
  `SUPABASE_SECRET_KEY` in `apps/web`, in `apps/studio/src`, Vercel or a `NEXT_PUBLIC_*` variable;
  never create a user from the login form; never poll; never add a table without RLS and a policy;
  never `select("*")`; never use `next/link` across zones; never let `supabase status`'s
  `STUDIO_URL` reach the environment; never create a Supabase client at module load.
- `docs/conditional-docs.md`: "Read `app_docs/studio.md` when changing the studio (`apps/studio`),
  the `/studio` forwarding in `apps/web/next.config.ts`, login, the `reels` table or any migration,
  RLS, the test helpers or the CI Supabase stack."
- Root `README.md`: the tree gains `apps/studio/` and `supabase/`; a "Run the studio locally"
  subsection: `supabase start` (owner, once), fill `apps/studio/.env.development` and
  `apps/worker/.env.development` from `supabase status`, `supabase migration up --local`,
  `STUDIO_PORT=3001 yarn turbo run dev --filter=./apps/web --filter=./apps/studio`, open
  `http://localhost:3000/studio`; checks gain `yarn test:db`. No feature description.

### 16. Run the validation commands

Run every command under Validation Commands, fix what fails (never weaken a rule, type or test),
and confirm no em-dash was introduced: `grep -rnP "\\x{2014}" apps/studio apps/web/src/lib/studio-rewrites* app_docs/studio.md supabase .adw README.md`
returns nothing.

## Testing Strategy

### Unit Tests

- `apps/web/src/lib/studio-rewrites.test.ts`: origin resolution (empty, port, URL wins, trailing
  slash) and the three rewrite rules.
- `apps/studio/test-support/local-supabase.test.ts`: the guard throws for `https://x.supabase.co`,
  a lookalike host and a missing key; accepts `127.0.0.1:54431` and `localhost`.
- `apps/studio/src/lib/supabase-config.test.ts`, `confirm-url.test.ts`, `reels.test.ts`: config
  null handling, confirmation URL sources, uuid check, date formatting, name fallback.

### Test Coverage

- Unit, `studio-rewrites.test.ts`: catches a wrong forwarding target (for example `STUDIO_PORT`
  ignored or the asset prefix missing), which nothing catches today.
- Unit, `local-supabase.test.ts`: catches the admin helper reaching a non-local URL (Verification 1).
- Unit, `confirm-url.test.ts` and `reels.test.ts`: catch a magic link built for the wrong origin and
  an invalid id reaching Postgres.
- DB integration (`test:db`), `rls.test.ts`: catches a table without RLS or a policy, cross-owner
  reads, and writes through `authenticated` (Verification 2).
- DB integration (`test:db`), `realtime.test.ts`: catches Realtime leaking another owner's changes,
  with a positive control (Verification 3).
- E2E, `apps/studio/e2e/login.spec.ts`: catches a login form that creates users, a broken
  confirmation route or logout (Verification 4 and 5).
- E2E, `apps/studio/e2e/reels.spec.ts`: catches wrong order, another owner's reels in the list, and
  a missing not-found (Verification 6).
- E2E, `apps/studio/e2e/forwarding.spec.ts`: catches the landing page not forwarding `/studio` or
  the asset prefix (Verification 7). The existing `apps/web/e2e/*.spec.ts` prove the landing page is
  unchanged.

All fail without this feature (the files, routes, table and helpers do not exist).

### Edge Cases

- Studio built and started with no variables: pages render the "not configured" notice, no crash;
  `proxy.ts` passes through.
- Unknown email, malformed email, rate-limited email: neutral message or field error, never a user.
- Reused or expired token hash, missing `type` or `token_hash`: expired-link message.
- Reel id not a uuid, unknown uuid, another owner's uuid: not found (no Postgres error page).
- Signed-out visit to `/studio/reels/<id>`: back to the login form.
- `source_name` null: "Untitled reel".
- `STUDIO_URL` with a trailing slash; `STUDIO_PORT` empty string.
- Confirmation redirect behind the rewrite stays on the landing address (relative `Location`).
- Realtime negative half waits the full window, so a late leak is caught.

## Acceptance Criteria

- `GET http://localhost:$PORT/studio` and one `/studio-static/_next/...` asset answer 200 through
  the landing page; the landing specs pass unchanged.
- Signed out, `/studio` shows the email form; an unknown email creates no user.
- A generated token hash signs in and lands on `/studio` with the list; logout returns to the form.
- The list shows only the owner's reels, newest first, with name, status and created time; a reel
  page shows name and status; another owner's or an unknown id shows not found.
- `public.reels` has RLS, one owner `select` policy, no write policy, no anon access, and is in
  `supabase_realtime`; every `public` table has RLS and a policy (tested).
- Realtime delivers A's change to A within 5 s and nothing to B.
- `localSupabaseAdmin()` throws for `https://x.supabase.co`.
- `SUPABASE_SECRET_KEY` appears nowhere in `apps/web` or `apps/studio/src`; no `select("*")`; no
  polling; no client created at module load.
- `yarn build` passes with no studio variables; all gates below pass; CI is green with its own stack
  and never exports Supabase's `STUDIO_URL`.
- `.adw/project.md` keeps its nine headings in order, with the facts and the verbatim migration rule
  added; `app_docs/studio.md`, `docs/conditional-docs.md` and `README.md` updated; no em-dashes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies the new migration to the shared local stack (the one
  allowed database command; on failure report and stop, never reset).
- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/web --filter=./apps/studio`: ESLint in both workspaces.
- `yarn turbo run typecheck --filter=./apps/web --filter=./apps/studio`: `next typegen` and `tsc`.
- `yarn knip`: dead code and unused dependencies, including the new workspace.
- `yarn turbo run test --filter=./apps/web --filter=./apps/studio`: unit tests (rewrites helper,
  guard, studio helpers).
- `yarn turbo run test:db --filter=./apps/studio`: RLS and Realtime integration tests against the
  shared local stack.
- `env -u NEXT_PUBLIC_SUPABASE_URL -u NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY -u NEXT_PUBLIC_SITE_URL -u STUDIO_URL -u STUDIO_PORT yarn turbo run build --filter=./apps/web --filter=./apps/studio --force`:
  proves both apps build with no studio variables (the studio's own `.env.development` is not read
  by `next build`, which reads `.env.production*` and `.env`).
- `yarn build`: the unfiltered build, as the hooks and CI run it.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: landing specs unchanged plus the
  studio specs, against the run's servers (started with the profile's new web dev command).

## Notes

- New dependencies (all through `yarn workspace @edit-issebya/studio add ...`): runtime `next`,
  `react`, `react-dom`, `@supabase/ssr`, `@supabase/supabase-js`; dev: the same tooling versions as
  `apps/web` plus `pg` and `@types/pg` for the RLS catalogue test. `yarn.lock` changes in this PR.
- Integration tests live in a separate `test:db` task, not in `yarn test`, so the pre-push hook and
  CI's unit step never need a database; the profile's Tests section lists the new layer.
- `NEXT_PUBLIC_*` values are inlined at build: in CI the studio is built a second time after the
  local stack's values are exported. Locally and in ADW `next dev` reads
  `apps/studio/.env.development` at run time.
- The local auth rate limit (`email_sent = 2` per hour) can block repeated manual magic-link sends;
  specs never send email (unknown address only), so they are unaffected.
- The optional email template and any `supabase/config.toml` change take effect only after the
  owner restarts the shared stack; ADW never restarts it. Owner steps after merge (hosted migration,
  template, site URL, sign-ups off, the owner account, the studio's Vercel project and `STUDIO_URL`
  on the landing project) are outside the pipeline.
- `apps/studio/vercel.json` mirrors `apps/web/vercel.json`; `scripts/vercel-ignore.sh` is already on
  this branch.
- If the studio's `assetPrefix` turns out not to be served under `basePath` by Next 16.3.8, keep
  `/studio-static` and add the documented `beforeFiles` rewrite in the studio
  (`/studio-static/_next/:path+` to `/_next/:path+`), and record the deviation in `app_docs/studio.md`.
- Out of scope (#43 and later): upload, jobs and steps, the worker, Realtime subscription in the
  page, storage and AI stand-ins, the test clip, PostHog events.
