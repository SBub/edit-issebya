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
- The adapter's `init` calls `posthog.init` with `posthogInitOptions` (`src/lib/analytics.ts`):
  `api_host`, `defaults: "2026-01-30"`, `capture_exceptions: true` and
  `cookieless_mode: "always"`. In that mode (posthog-js 1.438.12, `@posthog/types`
  `PostHogConfig`) PostHog sets no cookie and uses no local or session storage; identity is a
  privacy-preserving hash made on PostHog's servers. Nothing is stored on the visitor's device, so
  no cookie banner is needed (Lei 41/2004 article 5), and the privacy policy says so. The PostHog
  project must have cookieless mode turned on in its settings, or these events are dropped.
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

| event                   | when                                                                                                                  | properties                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `$pageview`             | PostHog default capture                                                                                               | UTM properties captured by PostHog                               |
| `reel_slider_navigated` | the track settles on a new card after a swipe or scroll, an arrow key moves it, or a dot is tapped (`ReelSlider.tsx`) | `direction` (`prev`/`next`), `method` (`swipe`/`keyboard`/`dot`) |
| `reel_played`           | a reel starts playing on tap or click (`ReelCard.tsx`)                                                                | `reel_id`                                                        |
| `reel_fullscreen`       | the full-screen button on a phone opens a reel full screen (`ReelCard.tsx`)                                           | `reel_id`                                                        |
| `cta_clicked`           | the CTA opens the dialog                                                                                              | none                                                             |
| `call_form_started`     | first input in the dialog, once per dialog open                                                                       | none                                                             |
| `call_form_submitted`   | a submit that passes client validation                                                                                | none (never the answers)                                         |
| `checkout_started`      | the action returned a Checkout URL, before navigating                                                                 | none                                                             |
| `purchase_completed`    | thank-you state shown, once per `session_id` per page load (guarded in memory, never in storage)                      | `session_id`                                                     |

The last five are sent from `src/components/CallRequest.tsx`.

## UTM values

UTM values are kept twice: by PostHog's own capture on `$pageview`, and in the Checkout Session
metadata (see `app_docs/checkout.md`).

## Rules

- Never rename an event or a property.
- Never send form answers to PostHog.
- Never import `posthog-js` in `src/lib/analytics.ts`; pass the client in as an adapter.
- Never initialise PostHog under `navigator.webdriver` or outside production.
- Never drop `cookieless_mode: "always"` or write anything to cookies, local or session storage
  for analytics: the site has no consent banner. `e2e/analytics.spec.ts` asserts no cookies and
  empty local and session storage after the whole purchase flow. A reload of the thank-you URL
  sends `purchase_completed` again, so count unique `session_id` values.
- Never rename the `internal` super property.
