# Reel studio: /studio zone, magic-link login and reels list

**Specifications:**

- specs/issue-27-adw-c95d56bf-sdlc_planner-studio-zone-login-reels-list.md

## Overview

`apps/studio` (`@edit-issebya/studio`) is the reel studio, a second Next.js app served at
`edit.issebya.com/studio` through Next.js multi-zones. The owner signs in with a Supabase magic
link and sees only their own reels, read under row-level security. This slice is the skeleton:
login, a reels list and one reel's page (read only).

## How it works

### Zone and forwarding

- `apps/studio/next.config.ts`: `basePath: "/studio"` and `assetPrefix: "/studio-static"`. The
  asset prefix must equal `STUDIO_ASSET_PREFIX` in the landing page. `NEXT_PUBLIC_SITE_URL`, when
  set, adds its host to the Server Actions `allowedOrigins`.
- `apps/web/src/lib/studio-rewrites.ts`: `studioOrigin` (`STUDIO_URL`, else
  `http://localhost:$STUDIO_PORT`, default 3001) and `studioRewrites` (`/studio`, `/studio/:path+`
  and `/studio-static/:path+`), used by `apps/web/next.config.ts`. Read at build time.
- The studio is never opened on its own port: it is reached through the landing page's address.

### Login

- `apps/studio/src/app/actions.ts`: `sendMagicLink` validates the address, then calls
  `signInWithOtp` with `shouldCreateUser: false`. The answer is the same for a known address, an
  unknown one and a rate limit, so the form never reveals who has an account; an error is logged
  without the address. `signOut` ends the session and redirects to `/studio`.
- `apps/studio/src/lib/confirm-url.ts`: the link's target, `<origin>/studio/auth/confirm`.
  `NEXT_PUBLIC_SITE_URL` wins, otherwise `x-forwarded-proto` and `x-forwarded-host` (so a run on
  any port stays right), otherwise `host`.
- `apps/studio/src/app/auth/confirm/route.ts`: verifies the token hash (`type` `email` or
  `magiclink`) and answers a 303 with a relative `Location` (`/studio`, or `/studio?error=link`
  for a bad or used link). Relative, because behind the rewrite `request.url` carries the studio's
  internal host.
- `supabase/templates/magic-link.html` and the `[auth.email.template.magic_link]` block of
  `supabase/config.toml`: the email carries `{{ .RedirectTo }}?token_hash=...&type=email`.
- `apps/studio/src/proxy.ts`: refreshes the session cookie on every page request (the
  `@supabase/ssr` pattern); a no-op when the studio is not configured. Pages still check the user.
- `apps/studio/src/lib/supabase-server.ts`: one server client per request, never at module load,
  so `next build` needs no variables. `apps/studio/src/lib/supabase-config.ts` returns `null`
  without the two public variables; every page then shows `NotConfigured`.

### Reels

- `supabase/migrations/20261031105245_studio_skeleton.sql`: table `public.reels` (owner, status
  `uploading | uploaded | received | failed`, source key, bytes, name, timestamps), an
  `updated_at` trigger, RLS with one `select` policy for the owner, `anon` revoked, and
  `authenticated` limited to `select`. The table is in the `supabase_realtime` publication.
- `apps/studio/src/app/page.tsx`: signed out shows `LoginForm`; signed in shows `ReelList`,
  newest first. No owner filter in the query: RLS alone scopes the rows, so a missing policy is
  never masked.
- `apps/studio/src/app/reels/[id]/page.tsx`: one reel (status, size, created). A malformed id
  (`isReelId`) or a reel that is not the caller's is a 404; signed out redirects to `/studio`.
  Read once on the server, no polling.
- `apps/studio/src/lib/reels.ts`: named column lists (never `*`), status type, id check and
  formatters.

## How to Use

1. Start the shared local Supabase stack (the owner does this) and apply migrations with
   `supabase migration up --local`.
2. Fill `apps/studio/.env.development` and `apps/worker/.env.development` from the matching
   `.env.example` files.
3. Run the web and studio dev servers together (see the root `README.md`) and open
   `http://localhost:3000/studio`.
4. Enter an address that already has an account, open the emailed link (local mail: Mailpit), and
   the reels list appears.
5. For a quick sign-in in tests or review, open the URL printed by
   `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url`.

## Configuration

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`:
  inlined at build; the studio builds and starts without them.
- `STUDIO_URL` and `STUDIO_PORT`: where the landing page forwards `/studio` (`STUDIO_PORT`
  defaults to 3001; the studio's `dev` and `start` use it).
- `SUPABASE_SECRET_KEY` is read only by the test helpers in `apps/studio/test-support/`, from
  `apps/worker/.env.development`.

## Testing

- Unit: `apps/studio/src/lib/*.test.ts`, `apps/studio/test-support/local-supabase.test.ts` and
  `apps/web/src/lib/studio-rewrites.test.ts` (`yarn test`).
- DB integration: `apps/studio/db-tests/` (`yarn test:db`): RLS on every public table, owner
  isolation, Realtime follows RLS. Needs the local stack; not in the pre-push hook.
- E2E: `apps/studio/e2e/` (`login`, `reels`, `forwarding` specs, chromium, through the landing
  address), run after the landing suite by `yarn test:e2e`.

## Rules

- Do not use `SUPABASE_SECRET_KEY` in `apps/web` or in `apps/studio/src/`; only
  `apps/studio/test-support/` reads it.
- Do not point a test at anything but `127.0.0.1` or `localhost` (the helpers refuse other hosts).
- Do not create a user from the login form (`shouldCreateUser` stays `false`) and do not make its
  answer depend on whether the address has an account.
- Do not let a client write to `reels` through the publishable key: no `insert`, `update` or
  `delete` grant for `authenticated`, no `anon` access.
- Do not select `*` from `reels`; name the columns.
- Do not change `assetPrefix` on one side only: it must equal `STUDIO_ASSET_PREFIX`.
- Do not return an absolute `Location` from the confirm route.

## Notes

- Spans `apps/studio`, `apps/web` (rewrites only), `supabase/`, CI and the ADW profile; most of
  the change is in `apps/studio`.
- Uploads, the worker and R2 are later slices; `apps/studio/.env.example` already lists their
  variables.
- The magic-link template takes effect after the local Supabase stack restarts.
