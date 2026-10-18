# Feature: One-page landing for the reel editing offer, with Stripe Checkout and PostHog

## Metadata

issue_number: `1`
adw_id: `d5416729`
issue_json: `{"number":1,"title":"feat: one-page landing for the reel editing offer, with Stripe Checkout and PostHog"}` (full body in GitHub issue #1; every requirement below is taken from it)

## Feature Description

Replace the placeholder at `/` with the single-screen landing page for edit.issebya.com, a test of
interest in a reel editing service for founders and experts who record their own talking heads.
The page shows the value proposition (`h1` "You record. I edit, with taste."), who it is for, a
four-step process, the offer (8 reels under 30 seconds, 1200 EUR + VAT), a slider of reel cards
styled after the website's shop card, and one CTA, "Book your discovery call". The CTA opens a
native `<dialog>` with a six-field form; a valid submit calls a server action that creates a
Stripe Checkout Session carrying the answers and UTM parameters in its metadata, then the browser
goes to Stripe. Back on `/`, `?checkout=success&session_id=...` shows a thank-you dialog and
`?checkout=cancelled` shows a calm note near the CTA. PostHog (production only, never under
automation) measures the funnel with eight literal events.

The whole page fits the viewport, with no vertical or horizontal page scroll, at every viewport
from 320x568 to 1920x1080, with or without the dialog open, without clipping `html`/`body` and
without hiding any required element. This is the owner's hard requirement and the main thing the
specs verify.

## User Story

As a founder or expert who records my own talking-head videos
I want to understand in one screen what the editor offers, see examples, and book and pay for a discovery call
So that I can hand off the editing to someone with taste without hunting through a long site

## Problem Statement

`/` is a "Coming soon" placeholder. The owner needs to test real interest in the reel editing
offer: a visitor must be able to read the pitch, see reels, and commit with a payment, and the
owner must be able to see who paid (Stripe Dashboard, with the discovery-call answers attached)
and where the funnel leaks (PostHog). None of that exists: no content, no payment path, no
analytics, no tests beyond a smoke check.

## Solution Statement

- A server-rendered `src/app/page.tsx` reads `searchParams` (checkout state, `session_id`, UTM
  values through a pure helper) and renders a `h-dvh` grid: a text column (h1, sub-line, for-whom,
  process `<ol>`, offer with the price from `src/lib/offer.ts`, CTA and the cancelled note) and a
  reel slider column. Below `md`/landscape it stacks into one column where the slider's media is the
  only part that flexes (`flex-1 min-h-0`); text steps down with height-based variants. Nothing is
  hidden and nothing on `html`/`body` is clipped.
- Client islands: `ReelSlider` (scroll-snap track, prev/next buttons, arrow keys, no autoplay,
  muted inline videos, "Reel coming soon" placeholders) and `CallRequest` (CTA, form dialog,
  thank-you dialog, cancelled note), which call `posthog.capture` directly.
- Pure helpers in `src/lib/`, each unit-tested: `offer.ts` (price constant and its display
  string), `call-request.ts` (`parseCallRequest`), `checkout-params.ts` (Checkout Session params
  builder, tax behind `STRIPE_AUTOMATIC_TAX`), `stripe-key.ts` (key lookup honouring the E2E flag),
  `utm.ts` (pick the five UTM keys), `analytics.ts` (ported `startAnalytics`/`internalTagAction`).
- A server action (`src/app/actions.ts`, `"use server"`) validates again, builds the params,
  creates the Stripe client lazily inside the call and returns a typed result (`{ ok: true, url }`
  or a typed error, never a throw).
- E2E: `src/instrumentation.ts` starts an in-process MSW server under `E2E_MOCK_STRIPE=true`
  (copied pattern from the website), a mock route exposes the last captured Checkout body and the
  missing-key toggle, and Playwright specs cover no-scroll, content visibility, slider, form,
  checkout, missing key and analytics.
- Root `instrumentation-client.ts` starts PostHog through `startAnalytics`, as the dashboard does.

## Relevant Files

Use these files to implement the feature:

- `README.md`: run instructions; change only if they change (they do not, except possibly a
  pointer that E2E needs `E2E_MOCK_STRIPE=true` when running against an existing `yarn dev`).
- `AGENTS.md`: rules (Yarn only, no em-dashes, conventional commits, measure from the root box,
  one doc per feature, read Next docs first).
- `.adw/project.md`: ADW profile; Identity, Workspaces, Install, Build, Tests and Review must be
  updated (headings unchanged, order unchanged).
- `docs/conditional-docs.md`: the index; replace the "No feature docs yet" line with three lines.
- `src/app/page.tsx`: the placeholder to replace.
- `src/app/layout.tsx`: add Work Sans through `next/font/google`, drop `min-h-screen` from `body`
  (the `main` is `h-dvh`), keep `metadata`/`siteUrl`; add a description.
- `src/app/globals.css`: remove the dark override, `color-scheme: light`, add `@theme inline`
  (`--font-sans: var(--font-work)`, `--color-reel-card: #f1eac8`), keep `scrollbar-gutter: stable`
  and the `html` background comment.
- `src/lib/site-url.ts`: origin fallback for the Checkout return URLs.
- `e2e/home_page.spec.ts`: placeholder assertions to replace (new `h1`).
- `playwright.config.ts`: `workers: 1` with the reason, `webServer.env.E2E_MOCK_STRIPE: "true"`.
- `knip.json`: add the root `instrumentation-client.ts` to `project` if knip's Next plugin does
  not pick it up; `msw` and `@mswjs/interceptors` are imported with `webpackIgnore` dynamic
  imports, so check knip sees them (add to `ignoreDependencies` only if it reports them unused).
- `vitest.config.ts`: unchanged (`src/**/*.test.ts`).
- `.env.example`: new placeholders `STRIPE_AUTOMATIC_TAX=`, `NEXT_PUBLIC_VERCEL_ENV` comment,
  `E2E_MOCK_STRIPE=`.
- `package.json` / `yarn.lock`: new dependencies via `yarn add`.
- `.github/workflows/ci.yml`: no change needed; CI's `yarn start` server gets `E2E_MOCK_STRIPE`
  from `webServer.env` (verify Playwright passes it to `yarn start` too).
- Read-only references (copy, never import or edit):
  - `~/Dev/issebya/issebya-homes-ai-system/apps/website/src/instrumentation.ts` (`registerE2EMocks`, comments to keep)
  - `~/Dev/issebya/issebya-homes-ai-system/apps/website/src/lib/stripe.ts` (fetch client under the flag)
  - `~/Dev/issebya/issebya-homes-ai-system/apps/website/src/app/api/e2e-ical-mock/route.ts` (404 unless flag)
  - `~/Dev/issebya/issebya-homes-ai-system/apps/website/src/app/(main)/shop/ui/ProductCard.tsx`, `src/app/globals.css`, `src/app/layout.tsx` (card classes, colour, font)
  - `~/Dev/issebya/issebya-homes-ai-system/apps/website/playwright.config.ts` (`workers: 1` reason)
  - `~/Dev/issebya/adw-dashboard/instrumentation-client.ts`, `src/lib/analytics.ts`, `src/lib/analytics.test.ts` (only `startAnalytics`, `internalTagAction`, their types and tests)
- Next docs to read before writing code:
  - `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`
  - `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md`
  - `node_modules/next/dist/docs/01-app/02-guides/instrumentation.md`
  - `node_modules/next/dist/docs/01-app/02-guides/analytics.md`
  - `node_modules/next/dist/docs/01-app/02-guides/server-and-client-boundary.md` and the Server Functions / `use server` reference under `01-app/03-api-reference/01-directives/`
  - the `page.md` file convention (async `searchParams`) and `headers` function reference

### New Files

- `src/lib/offer.ts`: `OFFER = { amountCents: 120000, currency: "eur", productName: "8 reels under 30 seconds", reelCount: 8, maxSeconds: 30 }` and `formatOfferPrice()` returning `"1200 EUR + VAT"` (derived from `amountCents`, never a second literal).
- `src/lib/offer.test.ts`: the display string is derived from the constant.
- `src/lib/call-request.ts`: field keys (`CALL_REQUEST_FIELDS`, literal), `parseCallRequest(input)` returning `{ ok: true, value }` or `{ ok: false, errors: Partial<Record<Field, string>> }`.
- `src/lib/call-request.test.ts`
- `src/lib/utm.ts`: `UTM_KEYS` and `pickUtm(params)`: trims, drops empty, caps at 500 characters.
- `src/lib/utm.test.ts`
- `src/lib/checkout-params.ts`: `buildCheckoutParams({ request, utm, origin, automaticTax })` returning `Stripe.Checkout.SessionCreateParams` (type-only import of `stripe`).
- `src/lib/checkout-params.test.ts`
- `src/lib/stripe-key.ts`: `stripeSecretKey(env, e2eKeyMissing)`: real key, or `sk_test_e2e_mock` only under the flag, or `null`; the flag-only missing toggle.
- `src/lib/stripe-key.test.ts`
- `src/lib/analytics.ts`: ported `startAnalytics`, `internalTagAction`, `AnalyticsEnv`, `AnalyticsBrowser`, `AnalyticsClient`, `InternalTagAction`; never imports `posthog-js`.
- `src/lib/analytics.test.ts`: ported cases.
- `src/lib/e2e-stripe-mock.ts`: the typed `globalThis` slots (`__e2eStripeLastCheckout`, `__e2eStripeKeyMissing`) and their getters/setters, shared by instrumentation, the route and the action (one place for the names).
- `src/app/actions.ts`: `"use server"`, `startCheckout(input)`.
- `src/app/api/e2e-stripe-mock/route.ts`: `GET`, `POST`, `DELETE`, 404 unless the flag.
- `src/instrumentation.ts`: `register()` with the MSW mock.
- `instrumentation-client.ts` (repository root): PostHog start-up.
- `src/content/reels.ts`: `type Reel`, `REELS` with four placeholders.
- `src/content/landing.ts`: the copy (h1, sub-line, for-whom, steps, offer line, CTA, notes), so the page and specs read one source. Optional; inline in the page is acceptable if it keeps the page readable.
- `src/components/ReelSlider.tsx` (`"use client"`), `src/components/ReelCard.tsx`, `src/components/CallRequest.tsx` (`"use client"`: CTA, form dialog, thank-you dialog, cancelled note), `src/components/CallForm.tsx` (fields and inline errors).
- `public/reels/.gitkeep`: where real `<id>.mp4` and `<id>.jpg` go.
- `e2e/viewport.ts`: `VIEWPORTS` list and `rootBox(page)` returning `{ scrollWidth, clientWidth, scrollHeight, clientHeight }` of `document.documentElement`; `fillValidForm(dialog)` and `waitForPageReady(page)` (fonts and slider) helpers.
- `e2e/no_scroll.spec.ts`, `e2e/landing_content.spec.ts`, `e2e/reel_slider.spec.ts`, `e2e/call_form.spec.ts`, `e2e/checkout.spec.ts`, `e2e/analytics.spec.ts`.
- `app_docs/landing-page.md`, `app_docs/checkout.md`, `app_docs/analytics.md`.

## Implementation Plan

### Phase 1: Foundation

Dependencies, theme, constants and pure helpers with their unit tests: `offer`, `call-request`,
`utm`, `checkout-params`, `stripe-key`, `analytics`. These carry every invariant that can drift
(price, metadata keys, tax flag, key fallback, PostHog gate) and are the cheapest layer to prove.

### Phase 2: Core Implementation

The page layout and content, the reel card and slider, the form and thank-you dialogs, the server
action, the Stripe client, the E2E mock (instrumentation, route) and PostHog start-up and events.

### Phase 3: Integration

Playwright config, the seven spec files, `.env.example`, the three feature docs and the index,
the ADW profile, then the full validation run and the review screenshots.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before writing

- Read the Next docs listed in Relevant Files (instrumentation, instrumentation-client, server
  functions, page `searchParams`, `headers`). Confirm where `instrumentation-client.ts` must live
  in a project with `src/app`: the issue (and the dashboard, which also has `src/app`) puts it at
  the repository root. If the installed docs say a `src/` project must use `src/instrumentation-client.ts`,
  follow the docs and note the deviation in `app_docs/analytics.md`.
- Read the sibling reference files listed above. Copy, never import.

### 2. Add dependencies

- `yarn add stripe posthog-js`
- `yarn add -D msw @mswjs/interceptors`
- Open `node_modules/stripe/types` (or `Stripe.API_VERSION` / the `LatestApiVersion` type) and note
  the `apiVersion` literal the installed SDK expects; use exactly that.
- Check the installed SDK's `Checkout.SessionCreateParams` for `tax_id_collection` and Stripe's
  docs (the `stripe:stripe-docs` skill or https://docs.stripe.com/tax/checkout/tax-ids) for what
  payment mode needs alongside it. Expected: `customer_creation: "always"` (payment mode without
  an existing customer), and possibly `billing_address_collection: "required"` for automatic tax
  to have an address. Record the verified answer with a link in a comment in `checkout-params.ts`
  and in `app_docs/checkout.md`. Do not guess.
- Check the msw version that `yarn add` picked still exports `SetupServerApi` from `msw/node`
  and `FetchInterceptor` from `@mswjs/interceptors/fetch`; if `@mswjs/interceptors` resolved to
  0.42+ (the fix the website comment mentions), keep the comment accurate about versions.

### 3. Theme, font and page colour

- `src/app/globals.css`: delete the `@media (prefers-color-scheme: dark)` block, set
  `color-scheme: light`, keep `scrollbar-gutter: stable` and both comments, add
  `@theme inline { --font-sans: var(--font-work); --color-reel-card: #f1eac8; --color-background: var(--background); --color-foreground: var(--foreground); }`.
- Add a height-based custom variant for the step-down text sizes, e.g.
  `@custom-variant short (@media (max-height: 700px));` and `@custom-variant tiny (@media (max-height: 600px));`
  (names are a suggestion). Width alone cannot tell 320x568 from 390x844.
- `src/app/layout.tsx`: `Work_Sans({ subsets: ["latin"], variable: "--font-work", display: "swap" })`,
  `className={workSans.variable}` on `<html>`, `font-sans antialiased` on `<body>` (no
  `min-h-screen`), add `description` metadata from the sub-line.

### 4. `src/lib/offer.ts` and test

- The constant from New Files, `tax_behavior` is not here (it is a checkout concern) but the
  module doc says the amount is tax-exclusive.
- `formatOfferPrice()` builds `${amountCents / 100} EUR + VAT` (no thousands separator, so the
  rendered text is exactly `1200 EUR + VAT`). Test: equals `"1200 EUR + VAT"` and changes when the
  amount would (assert it is computed from `OFFER.amountCents`).

### 5. `src/lib/call-request.ts` and test

- Fields in order: `name`, `email`, `company_role`, `content_link`, `reels_purpose`, `call_times`,
  each with a label and, for `call_times`, the hint "e.g. weekdays 10:00 to 13:00 Lisbon time".
  Export the keys as a literal `as const` tuple; the form, the server and the metadata builder all
  read it.
- `parseCallRequest(input: Record<string, unknown>)`: string-coerce only strings (non-strings are
  missing), trim, required check ("Please fill this in." style message per field), email shape
  (simple, non-backtracking pattern: `^[^\s@]+@[^\s@]+\.[^\s@]+$`; `security/detect-unsafe-regex`
  is on), `content_link` must parse with `URL.canParse` and have `http:`/`https:` protocol, every
  field at most 500 characters after trimming (message names the cap). Distinct messages for
  missing, bad email, bad URL and too long, so the e2e spec can tell them apart.
- Tests: each rule rejects and accepts (empty, whitespace only, missing key, non-string value,
  bad email, good email, `ftp://` and `example.com` rejected, `https://` accepted, 500 accepted,
  501 rejected, values trimmed in the result, all six errors at once on an empty object).

### 6. `src/lib/utm.ts` and test

- `UTM_KEYS = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"] as const`.
- `pickUtm(params: Record<string, string | string[] | undefined>)` (the shape of Next's
  `searchParams`): first value of arrays, trimmed, empty dropped, cut to 500 characters, unknown keys
  ignored. The server action re-runs `pickUtm` on what the client sends (never trust the client).
- Tests: picks only the five keys, drops empty, takes the first of repeated values, caps length.

### 7. `src/lib/checkout-params.ts` and test

- `buildCheckoutParams({ request, utm, origin, automaticTax }): Stripe.Checkout.SessionCreateParams`
  with `mode: "payment"`, one line item `{ price_data: { currency: OFFER.currency, unit_amount: OFFER.amountCents, tax_behavior: "exclusive", product_data: { name: OFFER.productName } }, quantity: 1 }`,
  `customer_email: request.email`, `metadata` with the six literal keys plus present UTM keys,
  `success_url: \`${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}\``,
`cancel_url: \`${origin}/?checkout=cancelled\``, and only when `automaticTax`is true:`automatic_tax: { enabled: true }`, `tax_id_collection: { enabled: true }` plus the companion
  parameter verified in step 2.
- `automaticTaxEnabled(value: string | undefined)` returns `value === "true"` (exact).
- Tests: line item amount/currency/name come from `OFFER` (compare against the import), tax keys
  absent for `undefined`, `""`, `"TRUE"`, `"1"`, present for `"true"`; metadata keys are exactly the
  expected literals; UTM keys absent when not given; the `{CHECKOUT_SESSION_ID}` placeholder is left
  literal in `success_url`.

### 8. `src/lib/stripe-key.ts`, `src/lib/e2e-stripe-mock.ts` and test

- `e2e-stripe-mock.ts`: `isE2EMockStripe(env = process.env)` (`=== "true"`), typed accessors for
  `globalThis.__e2eStripeLastCheckout: string | null` (raw form body) and
  `globalThis.__e2eStripeKeyMissing: boolean`.
- `stripeSecretKey({ STRIPE_SECRET_KEY, E2E_MOCK_STRIPE }, keyMissingToggle)`: when the flag is
  `"true"` and the toggle is on, `null`; else a non-empty trimmed `STRIPE_SECRET_KEY`; else
  `"sk_test_e2e_mock"` only when the flag is `"true"`; else `null`. Outside the flag the toggle is
  ignored.
- Tests: real key returned; missing key and no flag gives `null`; flag without key gives the mock
  literal; toggle on with flag gives `null` even with a real key; toggle on without flag is ignored;
  flag `"1"` behaves like no flag.

### 9. `src/lib/analytics.ts` and test (ported)

- Copy only `internalTagAction`, `startAnalytics`, the `INTERNAL_PROPERTY` constant and the types
  from the dashboard, adjusting the header comment (no identity store here).
- Port the dashboard's `internalTagAction` and `startAnalytics` test cases (skip the
  `createIdentityStore` block), including: production + token + host + `webdriver: true` does not
  call `init`; the same with `webdriver: false` does; undefined webdriver behaves like false;
  missing token, missing host, non-production and no browser all skip init; `?internal=1` registers
  after init; `?internal=0` unregisters.

### 10. Reel content

- `src/content/reels.ts`: `export type Reel = { id; title; caption; label; duration; videoSrc: string | null; poster: string | null }`
  and `export const REELS: readonly Reel[]` with four placeholders (e.g. `founder-story`
  "Founder story", `expert-tip`, `product-demo`, `behind-the-scenes`), short titles, two-line
  captions, durations under 0:30, `videoSrc: null`, `poster: null`. A comment says how to add one
  (link to `app_docs/landing-page.md`).
- `public/reels/.gitkeep`.

### 11. `ReelCard`

- `<article aria-labelledby>` with the card box `flex flex-col bg-reel-card p-3.5 text-foreground`
  and the class string exported as a constant like the website's `PRODUCT_CARD_BOX_CLASS`.
- Media area `relative flex-1 min-h-0 [container-type:size]` with the 9:16 box centred inside:
  `aspect-[9/16] w-[min(100cqw,calc(100cqh*9/16))] mx-auto`, so its height is what flexes and its
  width follows; it never overflows the card at any slot width.
  - `videoSrc` set: `<video muted playsInline loop preload="metadata" poster>` with no `autoPlay`
    and no `controls`, wrapped in a `<button aria-label="Play <title>" / "Pause <title>">` that
    toggles `play()`/`pause()`; a visible play icon overlay while paused. Fire `reel_played`
    `{ reel_id }` when `play()` resolves after a click. Set `muted` as a property too (React's
    `muted` attribute is known not to reflect reliably); no unmute control.
  - `videoSrc` null: a neutral 9:16 box (`bg-neutral-200`, centred text "Reel coming soon").
- Text block `flex flex-col gap-1.5 pt-3 text-xs`: label
  `text-center uppercase tracking-[0.2em] text-[10px]`, title row
  `flex justify-between gap-2 font-medium text-sm` with the title `underline underline-offset-4 truncate`
  and duration in `shrink-0`, caption `leading-relaxed line-clamp-2`. Each part gets a stable hook
  for specs (role or `data-testid` such as `reel-media`, `reel-label`, `reel-title`, `reel-caption`).

### 12. `ReelSlider` (`"use client"`)

- `<section aria-roledescription="carousel" aria-label="Edited reels">`, a header row with a small
  heading and the two buttons (`aria-label` "Previous reel" / "Next reel", secondary styling, never
  styled like the CTA), and the track: `flex gap-3 overflow-x-auto snap-x snap-mandatory overscroll-x-contain`
  with hidden scrollbar styling, `min-h-0 flex-1`, `[container-type:inline-size]` on the slider so
  card slot widths follow the slider's width: `basis-full` by default, two per view from about
  28rem, three from about 44rem, four from about 60rem (each slot `shrink-0 snap-start`). One card
  at 320 to 414.
- Ends: derive `atStart`/`atEnd` from `scrollLeft`, `clientWidth`, `scrollWidth` (1px tolerance) in
  a `scroll` listener plus a `ResizeObserver` (external system, so an effect is right); buttons
  `disabled` accordingly.
- Prev/next scroll by one slot width plus gap (`scrollBy({ left, behavior })`, `behavior: "auto"`
  under `prefers-reduced-motion`). Never `scrollIntoView`, which can scroll the page.
- `onKeyDown` on the section: ArrowLeft/ArrowRight call the same move and `preventDefault`, only
  while focus is inside the slider. Fire `reel_slider_navigated` `{ direction, method }` on each
  move that actually happens (not on a disabled end).
- The track's internal scroll lives inside the slider box, so it never widens the page.

### 13. Page layout (`src/app/page.tsx`)

- `export default async function HomePage({ searchParams })`: await it, derive
  `checkout: "success" | "cancelled" | null`, `sessionId` (only when it is a string),
  `utm = pickUtm(params)`.
- `<main className="grid h-dvh ...">`: two columns from `md` in landscape / `lg` (text column and
  slider column, both `min-h-0`), one column below with the slider row `minmax(0,1fr)` and the text
  rows `auto`. Padding and gaps step down with the height variants. Order in the one-column layout:
  h1 and sub-line, for-whom, process, offer, slider, CTA (keep the CTA last and close to the price).
- Copy (facts exact): h1 "You record. I edit, with taste."; sub-line "Reels for founders and
  experts who record their own talking heads."; for-whom "For founders and experts who record
  talking heads themselves. You bring the face and the ideas; I take care of the taste." (wording
  may tighten); `<ol aria-label="Process">` with the four steps; offer "8 reels, each under 30
  seconds." and the price from `formatOfferPrice()` with "+ VAT" visible.
- Text sizes step down (`text-3xl` to `text-xl` for h1, body to `text-xs`) with the height
  variants; nothing is `hidden`, `sr-only` or `display:none` at any breakpoint.
- Never add `overflow-hidden`/`overflow-clip` to `html`, `body` or `main`; `main` fits because
  every row is sized from `h-dvh`, and only the media flexes. (`overflow-hidden` on the media box
  inside a card is fine.)
- Render `<CallRequest checkout={checkout} sessionId={sessionId} utm={utm} />` in the CTA slot.

### 14. Server action (`src/app/actions.ts`)

- `"use server"`; `export async function startCheckout(input: { fields: Record<string, string>; utm: Record<string, string> }): Promise<StartCheckoutResult>` where
  `StartCheckoutResult = { ok: true; url: string } | { ok: false; error: "invalid"; fieldErrors } | { ok: false; error: "unavailable" }`.
- Steps: `parseCallRequest(input.fields)` (invalid returns `fieldErrors`); `stripeSecretKey(process.env, getKeyMissingToggle())`
  (null returns `unavailable`, logged with `console.error` without answers); origin from the
  request's `Origin` header via `headers()` when it parses as http(s), else `siteUrl(process.env)`
  (the run's port is not 3000, so the header is what makes return URLs correct locally and in
  e2e); `buildCheckoutParams` with `automaticTaxEnabled(process.env.STRIPE_AUTOMATIC_TAX)`;
  `new Stripe(key, { apiVersion: <installed>, ...(flag ? { httpClient: Stripe.createFetchHttpClient() } : {}) })`
  created inside the function (keep the website's comment about why the fetch client is used under
  the flag); `checkout.sessions.create(params)` in try/catch. A missing `session.url` or any thrown
  error returns `unavailable` and logs the error server-side. Never throw to the client.
- Put the client factory in `src/lib/stripe.ts` (`createStripeClient(key)`) if that keeps the
  action short; it must not run at module load.

### 15. `CallRequest` and `CallForm` (`"use client"`)

- CTA `<button>` "Book your discovery call", the only primary-styled control on the page;
  `onClick` opens the form dialog with `showModal()` and captures `cta_clicked`.
- Form dialog: native `<dialog aria-labelledby>` with `max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))]`,
  inner layout `flex flex-col` with a header (title, Close button `aria-label="Close"`), a body
  `overflow-y-auto min-h-0`, and the submit. `::backdrop` dimmed. Escape (native `cancel`) and
  Close both close it; on `close`, focus the CTA (`ctaRef.current?.focus()`, native dialogs usually
  restore focus, but do it explicitly so the spec is deterministic).
- `<form noValidate>` with the six fields from `CALL_REQUEST_FIELDS`, each with a `<label>`,
  `required`, `maxLength={500}`, `type="email"` / `type="url"` / `<textarea>` as specified, and an
  error `<p id="<field>-error">` that exists only when there is a message; the input carries
  `aria-invalid` and `aria-describedby` (hint and error ids). Native attributes stay for semantics
  and mobile keyboards; `noValidate` hands the messages to `parseCallRequest`, so client and server
  messages are identical and the inline messages are the ones the spec reads.
- Re-validate a field on `input` once it has an error, so fixing it clears the message.
- `call_form_started`: on the first `input` event per open (a ref reset on every open).
- Submit: run `parseCallRequest` on the form values; invalid sets errors, focuses the first invalid
  field, and does not call the action. Valid: capture `call_form_submitted` (no properties), call
  `startCheckout({ fields, utm })` in `useTransition` (button disabled with "Redirecting..." text
  while pending), then `ok` captures `checkout_started` and `window.location.assign(url)`;
  `invalid` shows the server's field errors; `unavailable` shows
  `<p role="alert">Payment is not available right now. Please try again later.</p>` inside the
  dialog. Inputs are uncontrolled with stable keys, so typed values remain after an error.
- Cancelled note: when `checkout === "cancelled"`, a `<p role="status">` near the CTA "Payment was
  not completed. You can try again any time." in muted, non-red styling.
- Thank-you dialog: same shell, opened with `showModal()` in an effect when `checkout === "success"`
  (syncing with the DOM dialog API, an external system); text "Thank you. Your payment is in. I will
  email you within two working days to set up the discovery call." and a Close button. When shown
  with a `sessionId`, capture `purchase_completed` `{ session_id }` once per id, guarded by
  `sessionStorage` key `purchase_completed:<id>` in try/catch (strict mode double effects and
  reloads must not double count). On close, `history.replaceState(null, "", "/")` so a reload
  shows the plain page.
- Events never carry form answers. Import `posthog from "posthog-js"` only in these client
  components (and the slider/card), never in `src/lib/analytics.ts`.

### 16. E2E Stripe mock

- `src/instrumentation.ts`: `register()` that, when `process.env.NEXT_RUNTIME === "nodejs"` and
  `E2E_MOCK_STRIPE === "true"`, dynamically imports `SetupServerApi` from `msw/node`, `http` and
  `HttpResponse` from `msw`, `FetchInterceptor` from `@mswjs/interceptors/fetch`, each with
  `/* webpackIgnore: true */`, and listens with `onUnhandledRequest: "bypass"`. Keep the website's
  two reasons as comments: the webpackIgnore/edge instrumentation graph resolution, and why only
  `FetchInterceptor` (the `ClientRequestInterceptor` passthrough socket bug, mswjs/interceptors#753).
- Handler `http.post("https://api.stripe.com/v1/checkout/sessions", async ({ request }) => ...)`:
  read `await request.text()`, store it via the `e2e-stripe-mock.ts` setter (last request only),
  parse with `URLSearchParams`, `id = \`cs_test_e2e_${crypto.randomUUID()}\``, return
`HttpResponse.json({ id, object: "checkout.session", url: successUrl.replace("{CHECKOUT_SESSION_ID}", id) })`.
- `src/app/api/e2e-stripe-mock/route.ts`: every method returns 404 JSON unless the flag is
  `"true"`. `GET` returns `{ body: Record<string,string> | null }` (the parsed last capture).
  `POST { keyMissing: boolean }` sets the toggle and returns it. `DELETE` clears the capture (an
  addition to the issue's GET/POST, needed because the specs share one server and the "no request
  captured" assertions must not see an earlier test's capture). Add `export const dynamic = "force-dynamic"`
  if the installed Next docs say route GETs can be cached.
- Verify in dev that the route and instrumentation share `globalThis` (the website relies on it);
  if Turbopack isolates them, keep the store in `globalThis` via `Symbol.for(...)` keys, which is
  process-wide.

### 17. PostHog start-up (`instrumentation-client.ts` at the root)

- Copy the dashboard file: reads `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST`,
  `NEXT_PUBLIC_VERCEL_ENV` literally, builds `{ webdriver: navigator.webdriver, search: window.location.search }`,
  and passes an adapter: `init` with `api_host`, `defaults: "2026-01-30"`, `capture_exceptions: true`;
  `register`; `unregister`. Comment that the gate makes every `posthog.capture` a no-op outside
  production.
- Check `defaults: "2026-01-30"` is accepted by the installed `posthog-js` types; if the type is a
  union that lacks it, use the newest listed value and note it in `app_docs/analytics.md`.
- Ensure knip and `tsconfig` include the file (tsconfig's `**/*.ts` include likely covers it).

### 18. Playwright config

- `workers: 1` with the reason as a comment (one dev server, one process-global toggle and
  capture; parallel specs would race on them), and `webServer.env: { PORT, E2E_MOCK_STRIPE: "true" }`.
  Comment that ADW's `/prepare_app` server is started as `E2E_MOCK_STRIPE=true yarn dev`, since an
  adopted server never sees `webServer.env`.

### 19. E2E helpers and specs (fail without the feature)

- `e2e/viewport.ts`: `VIEWPORTS` (the eleven sizes), `rootBox(page)`, `waitForPageReady(page)`
  (`document.fonts.ready` and the first reel card visible), `insideRoot(box, root)` assertion helper,
  `fillValidForm(dialog, values)`.
- `e2e/home_page.spec.ts`: replace with the new `h1` ("You record. I edit, with taste.") at 200,
  keep the 375px horizontal check (or delete the file if `no_scroll` covers it fully; then remove it
  from knip's view too).
- `e2e/no_scroll.spec.ts`: for each viewport, `/`, `/` with the dialog open (click the CTA), and
  `/?checkout=success&session_id=cs_test_x` with the thank-you dialog visible: `scrollHeight <= clientHeight`
  and `scrollWidth <= clientWidth`. Computed `overflow-x`/`overflow-y` of `html` and `body` not
  `hidden`/`clip`. Negative checks at 375x667 and 1920x1080: inject `<div style="height:200vh">`
  into `main` and expect `scrollHeight > clientHeight`; inject `<div style="width:200vw;height:1px">`
  and expect `scrollWidth > clientWidth` (each on a fresh load).
- `e2e/landing_content.spec.ts`: per viewport, the `h1`, for-whom text, the four `listitem`s in the
  process list, `getByText("1200 EUR + VAT")`, the first card's media, label, title and caption, and
  the CTA are `toBeVisible()` and their bounding boxes lie inside `[0, clientWidth] x [0, clientHeight]`.
  `emulateMedia({ colorScheme: "dark" })` then `body` background is `rgb(255, 255, 255)`.
- `e2e/reel_slider.spec.ts` at 375x667: first card in view (box inside the track box), "Previous
  reel" disabled; "Next reel" brings card 2 into view (poll with `expect.poll`); focus a slider button
  or the track, ArrowRight then ArrowLeft move forward and back; click next until disabled on the last
  card. Every `video` has `muted === true`, `autoplay === false`, `paused === true` after load (vacuous
  while there are none, so also assert the count equals the number of `REELS` with a `videoSrc`). The
  play-toggle check is `test.skip(REELS.every(r => r.videoSrc === null), "all reels are placeholders")`
  importing `REELS` from `src/content/reels.ts`, and a separate assertion that "Reel coming soon"
  renders for each placeholder.
- `e2e/call_form.spec.ts`: `DELETE /api/e2e-stripe-mock` first; open the dialog, submit empty: all six
  fields have `aria-invalid="true"` and the mock `GET` returns `body: null`; type a bad email and a
  non-URL link, each shows its own message (assert both texts); fix them, messages gone and
  `aria-invalid` cleared; Escape closes the dialog and the CTA is focused.
- `e2e/checkout.spec.ts`: (6) `DELETE` the capture, go to `/?utm_source=test&utm_campaign=spring`,
  fill valid values, submit, `waitForURL(/\/\?checkout=success&session_id=cs_test_e2e_/)`, thank-you
  dialog visible; `GET` body has `mode=payment`, `customer_email`, `line_items[0][price_data][unit_amount]=120000`,
  `[currency]=eur`, `[tax_behavior]=exclusive`, each `metadata[<key>]` as typed,
  `metadata[utm_source]=test`, `metadata[utm_campaign]=spring`, and no `metadata[utm_medium]`.
  (7) `POST { keyMissing: true }` and `DELETE` capture, fill and submit: `role="alert"` with the
  message inside the dialog, URL path still `/`, values remain, `GET` body still `null`; in `finally`
  `POST { keyMissing: false }`.
- `e2e/analytics.spec.ts`: record `page.on("request")` through load, slider next, form fill and the
  mocked checkout; no URL host contains `posthog.com` or the host of `process.env.NEXT_PUBLIC_POSTHOG_HOST`
  when set; `localStorage` has no key starting with `ph_`. Comment that the falsifiable gate is the
  `startAnalytics` unit test.

### 20. Config and docs

- `.env.example`: `STRIPE_AUTOMATIC_TAX=` with "set to true after configuring Stripe Tax";
  `NEXT_PUBLIC_VERCEL_ENV` as a comment only ("set by Vercel; never set by hand", no value line, or an
  empty commented line); `E2E_MOCK_STRIPE=` "tests only; true makes Stripe calls hit an in-process
  mock". Placeholders only.
- `app_docs/landing-page.md`: layout and the no-scroll rule (and how it is tested), the height
  variants, slider behaviour, how to add a reel (two files in `public/reels/`, an entry in `REELS`,
  short title, two-line caption), card styling sources (the three website files) and the deliberate
  differences (9:16 media, underline at rest, `line-clamp-2`). Rules: never page scroll at the listed
  viewports; never `overflow: hidden/clip` on `html`/`body`; never hide a required element; never a
  non-white background; never autoplay or sound; never `window.innerWidth` in specs.
- `app_docs/checkout.md`: data path, field and metadata keys, price constant, tax flag and the
  verified companion parameter, missing-key and Stripe-error behaviour, thank-you does not confirm with
  Stripe (Dashboard is the source of truth), the E2E mock (flag, route, toggle, capture, `sk_test_e2e_mock`),
  what the owner configures in Stripe (keys in Vercel, Stripe Tax with Lisbon origin, Portugal
  registration and any OSS registrations, services tax code, `STRIPE_AUTOMATIC_TAX=true`, branding and
  business name, receipt email), and plainly: "This code has not been run against a real Stripe
  account." Rules: never drift shown vs charged price; never rename metadata keys; never throw from the
  action; never create the client at module load; the mock is inert unless the flag is `"true"`; never
  commit a real key.
- `app_docs/analytics.md`: init conditions, `?internal=1`/`?internal=0`, events table (literal names
  and properties), UTM kept twice. Rules: never rename an event; never send form answers; never import
  `posthog-js` in `src/lib/analytics.ts`; never initialise under `navigator.webdriver` or outside
  production.
- `docs/conditional-docs.md`: remove the placeholder line; add one line per doc ("Read
  `app_docs/landing-page.md` when changing the page layout, copy, reel slider or reel cards", etc.).
- `.adw/project.md` (no heading renamed or reordered):
  - Identity: the app now uses Stripe Checkout and PostHog (optional variables).
  - Workspaces: dev command for ADW is `E2E_MOCK_STRIPE=true yarn dev`; health still `/`; the app
    calls Stripe only on submit, mocked under the flag.
  - Install: `.env*` still optional; the page builds and runs with no variables.
  - Build: `yarn build` needs no variables; optional `STRIPE_SECRET_KEY`, `STRIPE_AUTOMATIC_TAX`,
    `NEXT_PUBLIC_POSTHOG_*`, `NEXT_PUBLIC_VERCEL_ENV` (Vercel).
  - Tests: the `/prepare_app` server must be started as `E2E_MOCK_STRIPE=true yarn dev` for the
    checkout specs; specs run with `workers: 1`.
  - Review: the nine captures (`/`, `/` with the dialog open, `/?checkout=success&session_id=cs_test_review`
    at 1920x1080, 375x667 and 320x568), viewport-sized, not full page.
- `README.md`: only if run instructions change (add `E2E_MOCK_STRIPE=true yarn dev` before
  `yarn test:e2e` against an existing server). No feature description.
- Grep the diff for em-dashes (`grep -rnP "\x{2014}"`) and fix any.

### 21. Review screenshots

- With the server on this run's port, capture `/`, `/` after clicking the CTA, and
  `/?checkout=success&session_id=cs_test_review` at 1920x1080, 375x667 and 320x568 into
  `agents/d5416729/<agent_name>/review_img/`. Check visually that nothing is cut off and the dialog
  body scrolls internally at 320x568.

### 22. Run the validation commands

- Run every command in `Validation Commands` from the root and fix anything that fails without
  weakening a rule, type or test.

## Testing Strategy

### Unit Tests

- `src/lib/offer.test.ts`: price string derived from the constant.
- `src/lib/call-request.test.ts`: required, trim, email, http(s) URL, 500 cap, non-string inputs, all
  errors at once, trimmed values on success.
- `src/lib/utm.test.ts`: only the five keys, empty dropped, repeated values, cap.
- `src/lib/checkout-params.test.ts`: price from `OFFER` on the line item, `tax_behavior: "exclusive"`,
  tax keys only for exactly `"true"`, literal metadata keys, return URLs.
- `src/lib/stripe-key.test.ts`: the fallback and toggle are inert without the flag.
- `src/lib/analytics.test.ts`: ported `startAnalytics` and `internalTagAction` cases, including the
  `webdriver: true` / `false` gate.

### Test Coverage

- Unit `call-request.test.ts`: catches a server accepting a missing, malformed or over-long field that Stripe metadata would reject.
- Unit `checkout-params.test.ts`: catches the charged amount drifting from the shown price, a renamed metadata key, or tax being sent without `STRIPE_AUTOMATIC_TAX=true`.
- Unit `stripe-key.test.ts`: catches the `sk_test_e2e_mock` fallback or the missing-key toggle leaking outside the E2E flag.
- Unit `analytics.test.ts`: catches PostHog initialising in an automated browser or outside production (the only falsifiable proof of the webdriver branch).
- Unit `offer.test.ts` and `utm.test.ts`: catch the price text and the UTM metadata drifting from their sources.
- E2E `no_scroll.spec.ts`: catches any page scroll at the eleven viewports (plain, dialog open, thank-you) and clipping on `html`/`body`; its negative checks prove the measurement can fail.
- E2E `landing_content.spec.ts`: catches a required element hidden or cut off at any viewport, and a dark background.
- E2E `reel_slider.spec.ts`: catches broken prev/next, arrow keys, end states, autoplay or unmuted video.
- E2E `call_form.spec.ts`: catches missing inline validation, the action being called with invalid data, and focus not returning to the CTA.
- E2E `checkout.spec.ts`: catches wrong Checkout params (mode, email, price, metadata, UTM) and a crash or lost input when the key is missing.
- E2E `analytics.spec.ts`: catches any PostHog request or storage under automation.
- `e2e/home_page.spec.ts` updated to the new `h1`. No agent-driven `e2e/*.md` journey: every behaviour is covered deterministically by the specs above.

### Edge Cases

- 320x568: dialog body scrolls internally while the page does not; slider media is small but complete.
- Long single-word titles truncate on one line; captions clamp to two lines.
- `searchParams` with repeated or array values (`?utm_source=a&utm_source=b`), empty UTM values, `session_id` missing on success (thank-you shown, no `purchase_completed`).
- Reload of the thank-you URL: no second `purchase_completed` (sessionStorage guard); `sessionStorage` throwing (private mode) is caught.
- Double-click on submit: button disabled while pending; one Checkout request.
- Stripe returns a session without `url`, or throws: same alert path.
- `STRIPE_AUTOMATIC_TAX` set to `"TRUE"` or `"1"`: no tax params.
- Whitespace-only field values; values of exactly 500 and 501 characters; `javascript:` and `ftp:` links.
- Escape during a pending submit; closing and reopening the dialog resets `call_form_started` but keeps typed values.
- Arrow keys at the ends do nothing and send no event; resize changes cards per view and recomputes end states.
- Dark colour scheme and forced dark mode: background stays white.
- Linux Chromium 15px scrollbar gutter (CI): all measurements use the root box.

## Acceptance Criteria

- `/` renders the h1, sub-line, for-whom text, four ordered steps, "8 reels, each under 30 seconds", "1200 EUR + VAT", the slider with four "Reel coming soon" cards in the shop-card style (`#f1eac8`, `p-3.5`, Work Sans), and one CTA "Book your discovery call".
- At all eleven viewports, with and without the form or thank-you dialog open, `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth` of `document.documentElement`, `html`/`body` overflow is neither `hidden` nor `clip`, and every required element is visible inside the root box.
- `body` background is white under a dark colour scheme.
- Slider: prev/next with accessible names, disabled at the ends, arrow keys work inside it, one card per view at phone widths, no autoplay, every video muted, inline and paused until clicked.
- Form: six required fields with inline messages, `aria-invalid`, `aria-describedby`; invalid submit never calls the action; Escape and Close close the dialog and focus returns to the CTA.
- Valid submit under the mock lands on `/?checkout=success&session_id=cs_test_e2e_...` with the thank-you dialog, and the captured Checkout body has the exact mode, email, price, currency, tax behaviour, six metadata values and UTM values.
- Without a key, the dialog shows the `role="alert"` message, keeps the values, stays on `/`, and no Checkout request is made.
- `automatic_tax` and `tax_id_collection` (plus the verified companion) are sent only when `STRIPE_AUTOMATIC_TAX === "true"`.
- PostHog never initialises outside production or under `navigator.webdriver`; no PostHog request or `ph_` storage under Playwright; the eight event names and properties match the issue table and never include form answers.
- The E2E route answers 404 and the mock key is never used unless `E2E_MOCK_STRIPE === "true"`.
- Three feature docs with Rules sections, the index updated, `.env.example` and `.adw/project.md` updated with headings unchanged; no em-dashes; no sibling repo or `adws/` file in the diff.
- `yarn build` passes with no Stripe or PostHog variable set; all validation commands pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - Prettier formatting across the repo (CI runs it first).
- `yarn lint` - ESLint, including the security and no-secrets rules (the `sk_test_e2e_mock` literal and email regex must pass).
- `yarn typecheck` - `next typegen` then `tsc --noEmit`; proves the Stripe params type, the action's result type and the async `searchParams` typing.
- `yarn knip` - no unused files, exports or dependencies (new deps, root `instrumentation-client.ts`, e2e helpers).
- `yarn test` - Vitest unit tests for the six helpers in `src/lib/`.
- `env -u STRIPE_SECRET_KEY -u NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN -u NEXT_PUBLIC_POSTHOG_HOST -u STRIPE_AUTOMATIC_TAX yarn build` - the production build with no Stripe or PostHog variable set (no `.env*` file exists in the worktree unless copied at install).
- `PORT=<run port> yarn test:e2e` - the Playwright suite against the `/prepare_app` server started as `E2E_MOCK_STRIPE=true yarn dev` on this run's port (source `.ports.env`; never `CI=1`).

## Notes

- New dependencies (added with `yarn add`, versions picked by Yarn): `stripe`, `posthog-js` in `dependencies`; `msw`, `@mswjs/interceptors` in `devDependencies`. `apiVersion` is whatever the installed Stripe types expect.
- The garbled command variables were resolved from the issue JSON: issue number `1`, adw_id `d5416729`.
- Deliberate addition to the issue's mock route: `DELETE` clears the captured Checkout body, so the "no request captured" assertions in `call_form.spec.ts` and the missing-key spec are independent of test order on the shared server.
- Validation uses `parseCallRequest` on the client too (with `noValidate`), so the browser and the server produce the same messages; the native `required`/`type` attributes remain for semantics and mobile keyboards.
- Return URL origin comes from the request's `Origin` header first, then `siteUrl`; `siteUrl` alone would send ADW runs (not on port 3000) to the wrong port after the mocked Checkout.
- `next/font/google` downloads Work Sans at build time; CI already has network for installs.
- The tax-ID companion parameter must be verified against the installed SDK types and Stripe's docs (step 2), not assumed. Stripe Tax registrations are the owner's job and out of scope.
- Commits follow `feat:`/`chore:`/`docs:` with no trailers (AGENTS.md and the profile's Documentation section override any default attribution line).
- Out of scope: Vercel/domain/DNS, real Stripe and PostHog accounts and keys, real reels, webhook, database, email, calendar booking, other pages, phone landscape, viewports below 320x568, edits to sibling repos or `adws/`.
