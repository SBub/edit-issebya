# Analytics

The site measures with PostHog in the browser, in production only. Everywhere else (local dev, ADW
worktrees, Playwright, preview deploys) PostHog never initialises and every `posthog.capture` in
the components is a no-op.

## Start-up

- `instrumentation-client.ts` sits at the repository root, the location the installed Next docs
  accept for a `src/app` project (no deviation).
- It reads `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST` and
  `NEXT_PUBLIC_VERCEL_ENV` literally (they are inlined at build time) and calls `startAnalytics`
  (`src/lib/analytics.ts`) with an adapter over `posthog-js` (1.438.12).
- The adapter's `init` calls `posthog.init` with `api_host`, `defaults: "2026-01-30"` and
  `capture_exceptions: true`.
- PostHog initialises only when all of these hold:
  - `NEXT_PUBLIC_VERCEL_ENV === "production"` (set by Vercel, never by hand);
  - the token and the host are both set;
  - there is a browser (`navigator` and `window` exist);
  - `navigator.webdriver` is not `true`.
- `src/lib/analytics.test.ts` covers the gate. `e2e/analytics.spec.ts` asserts that no PostHog
  request is made and no `ph_` storage is written.

## Internal tag

After init, `?internal=1` registers the super property `internal: true` and `?internal=0`
unregisters it; any other value does nothing. The PostHog test-account filter matches the literal
`internal`. Tagging only adds the property the filter hides; it never opts out.

## Events

| event                   | when                                                                                                 | properties                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `$pageview`             | PostHog default capture                                                                              | UTM properties captured by PostHog                         |
| `reel_slider_navigated` | the track settles on a new card after a swipe or scroll, or an arrow key moves it (`ReelSlider.tsx`) | `direction` (`prev`/`next`), `method` (`swipe`/`keyboard`) |
| `reel_played`           | a reel starts playing on tap or click (`ReelCard.tsx`)                                               | `reel_id`                                                  |
| `cta_clicked`           | the CTA opens the dialog                                                                             | none                                                       |
| `call_form_started`     | first input in the dialog, once per dialog open                                                      | none                                                       |
| `call_form_submitted`   | a submit that passes client validation                                                               | none (never the answers)                                   |
| `checkout_started`      | the action returned a Checkout URL, before navigating                                                | none                                                       |
| `purchase_completed`    | thank-you state shown, once per `session_id` (guarded in `sessionStorage`, wrapped in try/catch)     | `session_id`                                               |

The last five are sent from `src/components/CallRequest.tsx`.

## UTM values

UTM values are kept twice: by PostHog's own capture on `$pageview`, and in the Checkout Session
metadata (see `app_docs/checkout.md`).

## Rules

- Never rename an event or a property.
- Never send form answers to PostHog.
- Never import `posthog-js` in `src/lib/analytics.ts`; pass the client in as an adapter.
- Never initialise PostHog under `navigator.webdriver` or outside production.
- Never rename the `internal` super property.
