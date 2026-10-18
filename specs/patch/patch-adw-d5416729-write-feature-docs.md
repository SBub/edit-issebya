# Patch: Write the three feature docs and update the docs index

## Metadata

adw_id: `d5416729`
review_change_request: `Issue #2: Step 20 and the acceptance criterion 'Three feature docs with Rules sections, the index updated' were not done. app_docs/ is empty: app_docs/landing-page.md, app_docs/checkout.md and app_docs/analytics.md do not exist. docs/conditional-docs.md is unchanged and still says 'No feature docs yet: the site is a placeholder page.'. Code comments in src/content/reels.ts, src/app/page.tsx, src/lib/analytics.ts and instrumentation-client.ts point at these missing docs. Without the docs, several things the issue requires are recorded nowhere: the Rules sections (the 'never' invariants), what the owner must configure in Stripe, the statement 'This code has not been run against a real Stripe account', the events table, how to add a reel, and the msw 3 deviation. Resolution: Write the three docs as step 20 specifies, each with a Rules section. app_docs/landing-page.md: layout, the no-scroll rule and its specs, the short and tiny height variants, slider behaviour, how to add a reel, card styling sources and the deliberate differences. app_docs/checkout.md: data path, field and metadata keys, price constant, the tax flag with the verified customer_creation: "always" companion and its link, missing-key and Stripe-error behaviour, that the thank-you dialog does not confirm with Stripe, the E2E mock, the owner's Stripe setup, and 'This code has not been run against a real Stripe account.'. app_docs/analytics.md: init conditions, ?internal=1/?internal=0, the eight-event table, and that UTM values are kept twice. In docs/conditional-docs.md, replace the placeholder line with one line per doc. Use no em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-1-adw-d5416729-sdlc_planner-one-page-landing-checkout.md`
**Issue:** Step 20's documentation was never written. `app_docs/` is empty and `docs/conditional-docs.md` still holds the placeholder line, while `src/content/reels.ts:4`, `src/app/page.tsx:19`, `src/lib/analytics.ts:3` and `instrumentation-client.ts:11` link to docs that do not exist. The feature invariants, the owner's Stripe setup, the "not run against a real Stripe account" statement, the events table, the add-a-reel steps and the msw 3 deviation are recorded nowhere.
**Solution:** Documentation only, no code change. Create `app_docs/landing-page.md`, `app_docs/checkout.md` and `app_docs/analytics.md`, each describing what the shipped code does (facts below are taken from the current source, not from the plan) and ending with a `## Rules` section that holds the step 20 "never" invariants. Replace the placeholder line in `docs/conditional-docs.md` with one line per doc. No em-dashes anywhere.

## Files to Modify

Use these files to implement the patch:

- `app_docs/landing-page.md` (new)
- `app_docs/checkout.md` (new)
- `app_docs/analytics.md` (new)
- `docs/conditional-docs.md` (replace the placeholder line)

Do not touch the uncommitted `src/content/landing.ts` and `e2e/landing_content.spec.ts` changes (they belong to the earlier process-steps patch). No code file changes: the existing doc links in code already match the three new filenames.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

Shared shape for all three docs: `# <Title>`, a one-paragraph summary, `##` sections for the content below, and last a `## Rules` section of bullet points, each starting "Never" or "Do not" (they become invariants per AGENTS.md and the profile's Protected section). Reference files with backticks and repository-relative paths. Plain prose, commas/colons/parentheses instead of em-dashes. Re-read each source file named below while writing so every literal (names, class names, values) is copied exactly.

### Step 1: Write `app_docs/landing-page.md`

- **Layout** (`src/app/page.tsx`, `src/app/globals.css`): one `<main class="landing grid h-dvh">` with three grid areas, `text` (h1, sub-line, for-whom text, `<ol aria-label="Process">` of the four `LANDING.steps`, the offer line and `formatOfferPrice()`), `slider` (`ReelSlider`) and `cta` (`CallRequest`). Copy lives in `src/content/landing.ts`. The wide layout switches on at `@media (min-width: 64rem), (min-width: 48rem) and (orientation: landscape)` in `globals.css`. Every row is sized from `h-dvh`; the slider media is the only part that flexes. White background in every colour scheme (`color-scheme: light`, no dark override); `scrollbar-gutter: stable` on the root.
- **No-scroll rule and its specs**: at the eleven viewports in `e2e/viewport.ts` (320x568 up to 1920x1080), with and without the form or thank-you dialog open, `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth` on `document.documentElement`, `html`/`body` overflow is neither `hidden` nor `clip`, and every required element is visible inside the root box. Tested by `e2e/no_scroll.spec.ts` (with the helpers in `e2e/viewport.ts`, which measure from `document.documentElement`, never `window.innerWidth`) and `e2e/landing_content.spec.ts`; the dialogs scroll internally at 320x568.
- **Height variants**: `@custom-variant short (@media (max-height: 700px))` and `@custom-variant tiny (@media (max-height: 600px))` in `globals.css`; `short:` and `tiny:` (and `lg:short:`) step down text size, gaps and padding in `page.tsx`, `ReelCard` (`short:p-2.5`) and `CallRequest`. Name 390x844 as the viewport the comment in `globals.css` calls out.
- **Slider behaviour** (`src/components/ReelSlider.tsx`): a scroll-snap track that scrolls inside the slider box (never the page; `scrollBy` on the track, never `scrollIntoView`), card slots from a container query (one per view on phones, up to four on wide screens), previous/next buttons with accessible names, disabled at the ends (scroll position tracked with a scroll listener and a `ResizeObserver`), ArrowLeft/ArrowRight inside the slider, no autoplay. `ReelCard` videos are muted, `playsInline`, paused until clicked; a reel without `videoSrc` renders "Reel coming soon". Specs: `e2e/reel_slider.spec.ts`.
- **How to add a reel**: put `<id>.mp4` and `<id>.jpg` in `public/reels/`, add an entry to `REELS` in `src/content/reels.ts` with `id`, `title` (short), `caption` (fits two lines), `label`, `duration`, `videoSrc: "/reels/<id>.mp4"`, `poster: "/reels/<id>.jpg"`; the slider and its specs pick it up, then run `yarn test:e2e` to confirm nothing scrolls. `reel_id` in analytics is the `id`, so do not change an existing id.
- **Card styling sources**: the issebya.homes website's `apps/website/src/app/(main)/shop/ui/ProductCard.tsx` (cream box, `p-3.5`, label, title-and-duration and caption block), its `src/app/globals.css` (`#f1eac8`, here `--color-reel-card` / `bg-reel-card`) and its `src/app/layout.tsx` (Work Sans via `next/font/google`, here `--font-work` exposed as `--font-sans`). Copied, never imported.
- **Deliberate differences** from the shop card: 9:16 media (a size container, the 9:16 box takes the largest size that fits), title underlined at rest, caption `line-clamp-2`.
- **Rules**: Never let the page scroll at the listed viewports, with or without a dialog open. Never set `overflow: hidden` or `overflow: clip` on `html` or `body`. Never hide or cut off a required element below a breakpoint to make it fit. Never use a non-white page background, in any colour scheme. Never autoplay a reel or play sound unasked. Never measure from `window.innerWidth`/`innerHeight` in specs; measure from the root box.

### Step 2: Write `app_docs/checkout.md`

- **Data path**: CTA opens the form dialog (`src/components/CallRequest.tsx`, `CallForm.tsx`); the form is `noValidate` and runs `parseCallRequest` (`src/lib/call-request.ts`) in the browser; a valid submit calls the server action `startCheckout` (`src/app/actions.ts`) with the fields and the UTM values the page picked from `searchParams` (`pickUtm`, `src/lib/utm.ts`). The action validates again, resolves the key (`stripeSecretKey`, `src/lib/stripe-key.ts`), builds params (`buildCheckoutParams`, `src/lib/checkout-params.ts`), creates the client per call (`createStripeClient`, `src/lib/stripe.ts`, `apiVersion` `2026-09-30.endive` from `stripe` 23.0.0) and returns the Checkout URL; the browser navigates there. Return URLs: `success_url` `<origin>/?checkout=success&session_id={CHECKOUT_SESSION_ID}`, `cancel_url` `<origin>/?checkout=cancelled`, origin from the request's `Origin` header, falling back to `siteUrl` (`NEXT_PUBLIC_SITE_URL`, then `VERCEL_PROJECT_PRODUCTION_URL`).
- **Field and metadata keys**: the six `CALL_REQUEST_FIELDS` (`name`, `email`, `company_role`, `content_link`, `reels_purpose`, `call_times`), all required, max 500 characters (Stripe's metadata value cap), `email` pattern-checked, `content_link` http(s) only. They are the Stripe metadata keys, plus the five `UTM_KEYS` (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, first value, trimmed, capped at 500, empty dropped). `customer_email` is the email.
- **Price constant**: `OFFER` in `src/lib/offer.ts`, `amountCents: 120000`, `currency: "eur"`, product name "8 reels under 30 seconds", `tax_behavior: "exclusive"`; `formatOfferPrice()` renders "1200 EUR + VAT" from the same constant.
- **Tax flag**: `STRIPE_AUTOMATIC_TAX`, only the exact string `"true"` (`automaticTaxEnabled`) adds `automatic_tax: { enabled: true }`, `tax_id_collection: { enabled: true }` and `customer_creation: "always"`. State the verified answer as in the `checkout-params.ts` comment: in payment mode with a new customer Stripe requires nothing else for tax ID collection (https://docs.stripe.com/tax/checkout/tax-ids, "New customers"); `customer_creation: "always"` is the companion we send so the tax ID is saved on a Customer and Stripe reports its VAT verification result. Unset or anything else: no tax parameter is sent.
- **Missing-key and Stripe-error behaviour**: no key gives `{ ok: false, error: "unavailable" }`, logged server-side without the answers; a thrown Stripe error or a session without `url` gives the same result. The dialog shows the `role="alert"` message, keeps the values, stays on `/`. Invalid input gives `error: "invalid"` with field errors. The action never throws to the client.
- **Thank-you dialog**: `/?checkout=success&session_id=...` opens it from the URL alone; it does not retrieve or confirm the session with Stripe (no webhook), so it can be shown by anyone with the URL. The Stripe Dashboard is the source of truth for who paid. `?checkout=cancelled` shows nothing special. Closing it resets the URL to `/`.
- **E2E mock**: `E2E_MOCK_STRIPE` must be exactly `"true"` (set in `playwright.config.ts` `webServer.env`, or by hand as `E2E_MOCK_STRIPE=true yarn dev` for the ADW server). Then `src/instrumentation.ts` registers an in-process msw network that answers `POST https://api.stripe.com/v1/checkout/sessions` with `cs_test_e2e_<uuid>` and the success URL, capturing the raw body; the Stripe client uses `Stripe.createFetchHttpClient()` under the flag so the fetch interceptor sees the call; `sk_test_e2e_mock` (`E2E_MOCK_STRIPE_KEY`) stands in when no key is set. `/api/e2e-stripe-mock`: `GET` returns the captured body, `POST { keyMissing }` sets the missing-key toggle, `DELETE` clears the capture; every method 404s without the flag. Shared state lives on `globalThis` under `Symbol.for` keys (`src/lib/e2e-stripe-mock.ts`), which is why specs run with `workers: 1`. Specs: `e2e/checkout.spec.ts`, `e2e/call_form.spec.ts`.
- **msw 3 deviation**: the plan named msw 2's `SetupServerApi` from `msw/node`; the installed `msw` 3.0.3 replaced it, so the mock uses `defineNetwork` and `InterceptorSource` from `msw/experimental` with only `FetchInterceptor` from `@mswjs/interceptors/fetch` (0.45.8), `onUnhandledFrame: "bypass"`, all imports `webpackIgnore` dynamic. Installing only the fetch interceptor keeps clear of the `ClientRequestInterceptor` passthrough socket bug (https://github.com/mswjs/interceptors/issues/753). If msw moves `defineNetwork` out of `experimental`, update the import here and in the doc.
- **What the owner configures in Stripe**: `STRIPE_SECRET_KEY` in Vercel (Production; a test key for Preview), Stripe Tax with the Lisbon origin address, the Portugal registration and any OSS registrations, the services tax code on the account default, then `STRIPE_AUTOMATIC_TAX=true`; Checkout branding and the public business name; receipt emails for successful payments. None of this is done by the code.
- A plain sentence on its own line: "This code has not been run against a real Stripe account."
- **Rules**: Never let the shown price and the charged price drift (both come from `OFFER`). Never rename a metadata key (the six field keys and the five UTM keys). Never throw from `startCheckout`; return a typed result. Never create the Stripe client at module load. Never make the E2E mock, its route or `sk_test_e2e_mock` do anything unless `E2E_MOCK_STRIPE` is exactly `"true"`. Never commit a real Stripe key.

### Step 3: Write `app_docs/analytics.md`

- **Init conditions**: `instrumentation-client.ts` at the repository root (the location the installed Next docs accept for a `src/app` project, no deviation) reads `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_VERCEL_ENV` literally and calls `startAnalytics` (`src/lib/analytics.ts`) with an adapter over `posthog-js` (1.438.12): `init` with `api_host`, `defaults: "2026-01-30"`, `capture_exceptions: true`. PostHog initialises only when `NEXT_PUBLIC_VERCEL_ENV === "production"` (set by Vercel, never by hand), both variables are set, there is a browser, and `navigator.webdriver` is not `true`. So local dev, ADW worktrees, Playwright and preview deploys never initialise it, and every `posthog.capture` in the components is a no-op there. `e2e/analytics.spec.ts` asserts no PostHog request and no `ph_` storage; `src/lib/analytics.test.ts` covers the gate.
- **`?internal=1` / `?internal=0`**: after init, `?internal=1` registers the super property `internal: true`, `?internal=0` unregisters it, anything else does nothing; the PostHog test-account filter matches the literal `internal`. Tagging never opts out.
- **Events table** (literal names; copy from issue #1, matching the code):

  | event                   | when                                                                                             | properties                                                  |
  | ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
  | `$pageview`             | PostHog default capture                                                                          | UTM properties captured by PostHog                          |
  | `reel_slider_navigated` | previous or next, by button or arrow key (`ReelSlider.tsx`)                                      | `direction` (`prev`/`next`), `method` (`button`/`keyboard`) |
  | `reel_played`           | a reel starts playing on tap or click (`ReelCard.tsx`)                                           | `reel_id`                                                   |
  | `cta_clicked`           | the CTA opens the dialog                                                                         | none                                                        |
  | `call_form_started`     | first input in the dialog, once per dialog open                                                  | none                                                        |
  | `call_form_submitted`   | a submit that passes client validation                                                           | none (never the answers)                                    |
  | `checkout_started`      | the action returned a Checkout URL, before navigating                                            | none                                                        |
  | `purchase_completed`    | thank-you state shown, once per `session_id` (guarded in `sessionStorage`, wrapped in try/catch) | `session_id`                                                |

- **UTM kept twice**: PostHog's own capture on `$pageview`, and the Checkout Session metadata (see `app_docs/checkout.md`).
- **Rules**: Never rename an event or a property. Never send form answers to PostHog. Never import `posthog-js` in `src/lib/analytics.ts`; pass the client in as an adapter. Never initialise PostHog under `navigator.webdriver` or outside production. Never rename the `internal` super property.

### Step 4: Update `docs/conditional-docs.md`

- Replace the line `No feature docs yet: the site is a placeholder page.` with three bullet lines, one per doc:
  - ``- Read `app_docs/landing-page.md` when changing the page layout, copy, height variants, the reel slider or reel cards, adding a reel, or touching the no-scroll specs.``
  - ``- Read `app_docs/checkout.md` when changing the discovery-call form, the server action, the price, Stripe Checkout parameters or tax, the thank-you dialog, or the E2E Stripe mock.``
  - ``- Read `app_docs/analytics.md` when changing PostHog start-up, the `?internal` tag, adding, renaming or removing an event, or touching UTM handling.``
- Keep the existing heading and intro sentence.

### Step 5: Format and check for em-dashes

- `yarn format` to let Prettier normalise the new Markdown (tables included), then `grep -rnP "\x{2014}" app_docs docs` must print nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -rnP "\x{2014}" app_docs docs specs/patch` - no output (no em-dashes).
- `ls app_docs/landing-page.md app_docs/checkout.md app_docs/analytics.md && grep -c "^## Rules" app_docs/*.md && grep -n "This code has not been run against a real Stripe account." app_docs/checkout.md && ! grep -n "No feature docs yet" docs/conditional-docs.md` - all three docs exist, each has one Rules section, the statement is present, the placeholder is gone.
- `yarn format:check`
- `yarn lint && yarn typecheck && yarn knip && yarn test` - unchanged code still passes the commit and push hooks.
- `yarn build` - unaffected by docs; confirms the tree is still green.

## Patch Scope

**Lines of code to change:** about 220 lines of Markdown across three new docs, 3 lines in `docs/conditional-docs.md`; no code.
**Risk level:** low
**Testing required:** docs only: em-dash grep, presence checks, `yarn format:check`, and the commit/push hook checks to confirm nothing else changed. No E2E rerun needed (no rendered or runtime change).
