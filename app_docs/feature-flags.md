# Feature flags (studio)

**Specifications:**

- Owner request, 2026-11-16: the owner's Move editor sits behind a PostHog feature flag, on only for
  the owner for now. One flag covers the whole editor: text now, visuals later.

## Overview

The studio reads PostHog feature flags on the server, for the signed-in user, so a page renders
nothing behind an off flag and a server action refuses it. There is one flag today:

| Key                 | What it gates                                                                     | Read by                                                           |
| ------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `studio-owner-edit` | the owner's Move editor (`app_docs/owner-edits.md`): its button, the editor, Save | the reel page (`src/app/reels/[id]/page.tsx`), `requestOwnerEdit` |

A flag is off unless PostHog says it is on. PostHog unconfigured, unreachable, slow (over 1.5 s for
its answer, 3 s in all) or failing means off.

## How it works

- `apps/studio/src/lib/feature-flags.ts`:
  - `OWNER_EDIT_FLAG` is `studio-owner-edit`.
  - `isFlagOn(key, { id, email })` is true when the tests' override names the key; otherwise only
    when PostHog is configured and its answer is on. It never throws.
  - `flagsConfig()`: the server-only pair `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` when both are
    set, else the public pair the studio's analytics use (`NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`,
    `NEXT_PUBLIC_POSTHOG_HOST`); null, every flag off, when neither pair is complete.
  - `posthogEvaluator`: a short-lived `posthog-node` client per evaluation,
    `evaluateFlags(userId, { flagKeys: [key], personProperties: { email } })`, then
    `isEnabled(key, { sendFeatureFlagEvents: false })` (no `$feature_flag_called` event), then
    `shutdown`. The distinct id is the Supabase user id, the one `StudioIdentify` identifies the
    browser with. The email is passed as a person property for the evaluation only.
  - `flagOverrides()`: tests only, `E2E_MOCK_FLAGS`, a comma-separated list of keys turned on for
    everyone without PostHog.
- The reel page evaluates `studio-owner-edit` with its other reads and passes `ownerEdit` through
  `LiveReel` to `ReelPreview`; off, `BuiltPreview` renders no `Move text` button and no editor.
- `requestOwnerEdit` evaluates it again for the session's user before it queues the job, so a
  crafted call with the flag off queues nothing.

## Configuration

- In PostHog (project 312096): a boolean flag with the key `studio-owner-edit`, released to the
  owner only. Condition: the person property `email` equals the owner's email. The email is sent with
  every evaluation, so the condition holds both on the hosted studio and on the owner's local stack,
  where the Supabase user id differs. A condition on the distinct id (the Supabase user id) works
  too, but only for the stack whose user id it names.
- Production: the studio's two public PostHog variables are already set on Vercel; nothing to add.
- Local development: the public pair stays empty (no test clicks in PostHog), so set
  `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` in `apps/studio/.env.development` to read flags locally.
  With neither pair the editor is off locally.
- Tests: `E2E_MOCK_FLAGS=studio-owner-edit`, set by `apps/studio/playwright.config.ts` for the
  studio server it starts and by the ADW dev command in `.adw/project.md`. Turbo passes `E2E_MOCK_*`
  and the two server-only variables through `dev` and `start`.

## Testing

- `apps/studio/src/lib/feature-flags.test.ts` (unit, a fake evaluator, never PostHog): the
  configuration pairs, the override list, on when PostHog says on (with the user id and email), off
  when it says off, fails or is not configured, on with the override alone.
- `apps/studio/e2e/owner-edit.spec.ts` runs with the flag on through `E2E_MOCK_FLAGS`.

## Rules

- Never evaluate a flag in the browser to decide what the server allows: the page and the action
  evaluate it on the server.
- Never treat a PostHog failure as on: unconfigured, unreachable or slow is off.
- Never send a `$feature_flag_called` event from these evaluations, and never call PostHog in a test.
- Never set `E2E_MOCK_FLAGS` outside tests.
- Never create or change a flag in PostHog from code or a test: the owner manages them.
