# Analytics

The site measures with PostHog in the browser, in production only. Everywhere else (local dev, ADW
worktrees, Playwright, preview deploys) PostHog never initialises and every `posthog.capture` in
the components is a no-op.

## Start-up

- `apps/web/instrumentation-client.ts` sits at the app's root (`apps/web/`, next to
  `next.config.ts`), the location the installed Next docs accept for an `apps/web/src/app` project
  (no deviation).
- It reads `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST` and
  `NEXT_PUBLIC_VERCEL_ENV` literally (they are inlined at build time) and calls `startAnalytics`
  (`apps/web/src/lib/analytics.ts`) with an adapter over `posthog-js` (1.438.12).
- The adapter's `init` calls `posthog.init` with `posthogInitOptions` (`apps/web/src/lib/analytics.ts`):
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
- `apps/web/src/lib/analytics.test.ts` covers the gate. `apps/web/e2e/analytics.spec.ts` asserts that no PostHog
  request is made and no `ph_` storage is written.

## Owner opt-out (`?notrack`)

Visiting any page with `?notrack` stores `edit_notrack` = `"1"` in this device's localStorage and
`?track` removes it; both parameters are then removed from the address bar
(`history.replaceState`, other parameters kept). While the flag is set, `startAnalytics` never
initialises PostHog and `capture` (`apps/web/src/lib/track.ts`, the only way components send events)
does nothing. The switch runs in `apps/web/instrumentation-client.ts` in every environment; all storage
access is wrapped in try/catch (`apps/web/src/lib/notrack.ts`). Specs: `apps/web/src/lib/notrack.test.ts`,
`apps/web/src/lib/track.test.ts`, `apps/web/e2e/notrack.spec.ts`. It is the owner's own switch, set deliberately,
so the privacy policy does not mention it.

## Internal tag

After init, `?internal=1` registers the super property `internal: true` and `?internal=0`
unregisters it; any other value does nothing. The PostHog test-account filter matches the literal
`internal`. Tagging only adds the property the filter hides; it never opts out.

## Events

| event                       | when                                                                                                                                                                                                                                                                                | properties                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `$pageview`                 | PostHog default capture                                                                                                                                                                                                                                                             | UTM properties captured by PostHog                                                                                  |
| `reel_slider_navigated`     | the track settles on a new card after a swipe or scroll, an arrow key moves it, or a dot is tapped (`ReelSlider.tsx`)                                                                                                                                                               | `direction` (`prev`/`next`), `method` (`swipe`/`keyboard`/`dot`)                                                    |
| `reel_played`               | a reel starts playing on tap or click (`ReelCard.tsx`)                                                                                                                                                                                                                              | `reel_id`, `variant`                                                                                                |
| `reel_fullscreen`           | the full-screen button on a phone opens a reel full screen (`ReelCard.tsx`)                                                                                                                                                                                                         | `reel_id`, `variant`                                                                                                |
| `reel_progress`             | playback crosses 25, 50 or 100 percent, each once per play-through; 100 is the end (`ended`, or the loop wrapping from the last tenth back to an earlier time); a play from the start (under 0.5 s) begins a new play-through (`ReelCard.tsx`, `apps/web/src/lib/reel-progress.ts`) | `reel_id`, `variant`, `percent` (`25`/`50`/`100`)                                                                   |
| `cta_clicked`               | the CTA opens the dialog                                                                                                                                                                                                                                                            | none                                                                                                                |
| `call_form_started`         | first input in the dialog, once per dialog open                                                                                                                                                                                                                                     | none                                                                                                                |
| `call_form_field_completed` | a text field loses focus holding something, or a checkbox is ticked; once per field per dialog open                                                                                                                                                                                 | `field` (`name`/`email`/`socials`/`terms`/`newsletter`)                                                             |
| `call_form_invalid`         | a submit blocked by client validation, or a server action `invalid` result                                                                                                                                                                                                          | `fields` (names of the fields with an error, in form order), `stage` (`client`/`server`)                            |
| `call_form_submitted`       | a submit that passes client validation                                                                                                                                                                                                                                              | none (never the answers)                                                                                            |
| `call_form_closed`          | the form dialog closes (Escape or the close button, the only ways `DialogShell` closes) without leaving for Stripe                                                                                                                                                                  | `fields_completed` (count this open), `last_field` (last field completed this open, or `null`), `started` (boolean) |
| `checkout_started`          | the action returned a Checkout URL, before navigating                                                                                                                                                                                                                               | none                                                                                                                |
| `checkout_failed`           | the action returned no URL                                                                                                                                                                                                                                                          | `reason` (`invalid`/`unavailable`)                                                                                  |
| `checkout_cancelled`        | the page loaded with `?checkout=cancelled`, once per page load (guarded in memory, never in storage)                                                                                                                                                                                | none                                                                                                                |
| `purchase_completed`        | thank-you state shown, once per `session_id` per page load (guarded in memory, never in storage)                                                                                                                                                                                    | `session_id`                                                                                                        |
| `message_clicked`           | the "Message me here" WhatsApp link is clicked (`QuestionsLink.tsx`)                                                                                                                                                                                                                | `location` (`offer` on `/`, `terms`, `privacy`)                                                                     |

`variant` is the reel's 1-based position in `REELS` (`reelVariant`, `apps/web/src/content/reels.ts`):
`poster-reel-04` = 1, `statement-reel-01` = 2, `editorial-reel-02` = 3. Reordering `REELS`
changes which reel a variant means.

The `cta_clicked` to `purchase_completed` rows (form, checkout outcomes) are sent from
`apps/web/src/components/CallRequest.tsx`. A server `invalid` result sends both `checkout_failed` and
`call_form_invalid` (`stage: "server"`); the client and the server run the same validator, so it
should not happen in practice. Field events carry names only (`apps/web/src/lib/call-form-events.ts`).
All go through `capture` (`apps/web/src/lib/track.ts`).

## Observing events in specs

PostHog never initialises under Playwright, so `capture` has a test hook: when
`navigator.webdriver` is `true` and a spec has put an array at `window.__capturedEvents`, each
event (after the `?notrack` check) is also pushed there. `apps/web/e2e/events.ts` sets it with
`addInitScript` and hands each push to the spec through `exposeFunction`, so the log survives
the round trip to Stripe. It lives in memory only and writes nothing to the device. Specs:
`apps/web/e2e/reel_slider.spec.ts`, `apps/web/e2e/call_form.spec.ts`, `apps/web/e2e/checkout.spec.ts`,
`apps/web/e2e/legal_pages.spec.ts`; unit: `apps/web/src/lib/track.test.ts`.

## UTM values

UTM values are kept twice: by PostHog's own capture on `$pageview`, and in the Checkout Session
metadata (see `app_docs/checkout.md`).

## Short links

Clean links for posts in WhatsApp groups and elsewhere: `edit.issebya.com/<slug>` sends the
visitor to `/?utm_source=...&utm_medium=...&utm_campaign=...`, so the post shows a short URL and
PostHog still records where the visit came from.

- The registry is `apps/web/src/content/links.ts` (`SHORT_LINKS`): one entry per link with `slug`,
  `source`, `medium`, `campaign`, `label` (the group's name, for people only) and `posted` (the
  ISO date it went out, or null).
- `apps/web/next.config.ts` turns it into `redirects()` through `shortLinkRedirects`
  (`apps/web/src/lib/short-links.ts`); the query is built with `URLSearchParams`. Redirects run before the
  filesystem and match case-insensitively, so `/CJO` works too; any query on the short link
  (say `?notrack`) is passed on to `/` next to the UTM parameters.
- The redirects are temporary (307), never permanent: browsers and link-preview crawlers cache a
  308 for good, and a link's target must stay changeable.
- Link previews: WhatsApp and iMessage follow the redirect and read the Open Graph tags on `/`
  (`app_docs/landing-page.md`). There is no proxy, and the `?notrack` and `?internal` handling
  runs in the browser only, so nothing stands between the crawler and the tags.
- On `/` the UTM values reach PostHog's `$pageview` and, through `pickUtm`
  (`apps/web/src/lib/utm.ts`), the Checkout Session metadata, as any tagged URL does.
- Specs: `apps/web/src/lib/short-links.test.ts` (target URL; slugs lowercase `[a-z0-9-]`, unique, not an
  existing route or `apps/web/public/` file; UTM values lowercase `[a-z0-9-]`; `posted` a real date) and
  `apps/web/e2e/short-links.spec.ts` (each slug answers 307 and lands on `/` with its three parameters and
  the heading visible).

To add a link: append an entry to `SHORT_LINKS` with a new slug and `posted: null`, run
`yarn test`, ship it, check the link opens the page with its preview, then post it and set
`posted` to that day's date.

## Rules

- Never rename an event or a property.
- Never send form answers to PostHog.
- Never import `posthog-js` in `apps/web/src/lib/analytics.ts`; pass the client in as an adapter.
- Never call `posthog.capture` from a component; use `capture` from `apps/web/src/lib/track.ts`, which
  honours the `?notrack` opt-out.
- Never send a form field's value: field events carry its name only.
- Never let the test hook record outside `navigator.webdriver` or write to storage.
- Never initialise PostHog under `navigator.webdriver` or outside production.
- Never drop `cookieless_mode: "always"` or write anything to cookies, local or session storage
  for analytics: the site has no consent banner. `apps/web/e2e/analytics.spec.ts` asserts no cookies and
  empty local and session storage after the whole purchase flow. A reload of the thank-you URL
  sends `purchase_completed` again, so count unique `session_id` values.
- Never rename the `internal` super property.
- Never rename, reuse or remove a short-link slug once it is posted (`posted` is set): old messages
  still point at it, and a short link must never show a "not found" page. Change its target
  values instead if needed, knowing PostHog then records the new ones.
- Never make a short-link redirect permanent.
