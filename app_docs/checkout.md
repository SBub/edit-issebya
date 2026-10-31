# Checkout

**Specifications:**

- specs/issue-46-adw-905a266a-sdlc_planner-webkit-server-worktree-env.md

The call to action ("Start your 30 days") opens the checkout form. A valid submit creates a Stripe Checkout Session
through a server action and sends the browser to Stripe. After payment Stripe returns to `/`, which
shows a thank-you dialog. The form answers and the UTM values travel in the session's metadata, so
the Stripe Dashboard shows who paid and why.

## Data path

1. The CTA in `apps/web/src/components/CallRequest.tsx` opens the form dialog (fields in
   `apps/web/src/components/CallForm.tsx`).
2. The form is `noValidate`. On submit the browser runs `parseCallRequest`
   (`apps/web/src/lib/call-request.ts`) and shows field errors without calling the server.
3. A valid submit calls the server action `startCheckout` (`apps/web/src/app/actions.ts`) with the fields
   and the UTM values the page picked from its `searchParams` (`pickUtm`, `apps/web/src/lib/utm.ts`).
4. The action validates again with the same `parseCallRequest`, picks the UTM values again,
   resolves the key (`stripeSecretKey`, `apps/web/src/lib/stripe-key.ts`), builds the params
   (`buildCheckoutParams`, `apps/web/src/lib/checkout-params.ts`) and creates a client for this call only
   (`createStripeClient`, `apps/web/src/lib/stripe.ts`, `apiVersion` `2026-09-30.endive`, the version
   `stripe` 23.0.0 is typed against).
5. It returns the Checkout URL and the browser navigates there.

Return URLs:

- `success_url`: `<origin>/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
- `cancel_url`: `<origin>/?checkout=cancelled`

The origin is the request's `Origin` header (so an ADW run on its own port lands back on itself),
falling back to `siteUrl` (`apps/web/src/lib/site-url.ts`: `NEXT_PUBLIC_SITE_URL`, then
`VERCEL_PROJECT_PRODUCTION_URL`, then `http://localhost:3000`).

## Fields and metadata keys

The form asks as little as possible. `CALL_REQUEST_FIELDS`, in order: `name`, `email`, `socials`,
`terms` (`apps/web/src/lib/call-request.ts`, rendered by `apps/web/src/components/CallForm.tsx`).

- `name` and `email` are required, trimmed, at most 500 characters; `email` is pattern-checked.
- `socials` is optional: one row to start, more with the + button (up to 10), each removable.
  Empty rows are dropped. A link without a scheme gets `https://` (`instagram.com/you` is what
  people type); anything that is still not an `http(s)` URL with a dotted host is rejected. The
  links, joined one per line, are capped at 500 characters.
- `terms` is a required checkbox linking to `/terms` and `/privacy` (see `app_docs/legal-pages.md`), labelled "I agree to the terms and conditions and the privacy policy". The
  "Continue to payment" button carries the native `disabled` attribute until the box is ticked,
  and again if it is unticked (`termsAccepted` in `CallRequest`, fed by `onTermsChange` from
  `CallFormFields`). So the terms error is no longer reachable from the browser; the server action
  still validates `terms` with `parseCallRequest` and returns it as a field error.
- `newsletter` is an optional checkbox below terms, unticked by default: "Send me occasional
  emails with new offers and tips. Unsubscribe any time" (`CALL_REQUEST_LABELS.newsletter`). It is
  GDPR consent, so it is never pre-ticked, never required and never affects the submit button.
  `parseCallRequest` reads `true` or `"on"` as yes and anything else as no; it never errors. It is
  not in `CALL_REQUEST_FIELDS` (that list is the fields that can show an error).
- The browser and the action run the same validator, so their messages are identical.

Stripe metadata (`toCheckoutMetadata`): `name`, `email`, `socials` (one link per line, empty when
none), `terms_accepted` (`"true"`), `newsletter` (`"true"` or `"false"`, the record of the
buyer's choice), `offer` (`"reels-8"`, what the sold count looks for), `price_tier` (`"early"` or
`"standard"`), plus the five `UTM_KEYS`: `utm_source`, `utm_medium`,
`utm_campaign`, `utm_term`, `utm_content` (first value of a repeated parameter, trimmed, capped at
500, empty values and unknown keys dropped). `customer_email` is the email.

`confirmation_email_sent` is the one key the code writes after creation: an ISO timestamp the
Stripe webhook sets once both confirmation emails are accepted (`app_docs/confirmation-email.md`).

## Price

`OFFER` in `apps/web/src/lib/offer.ts`: `amountCents: 99000`, `currency: "eur"`, product name
"8 reels, each under 1 minute", description "Visual identity, recording guide and 30 days to send
footage" (no trailing full stop, like `LANDING.afterPurchase` and `LANDING.thankYou`). `buildCheckoutParams` sends it as `price_data` with
`tax_behavior: "exclusive"`. `formatOfferPrice()` renders "990 EUR" from the same constant,
so the shown price and the charged price come from one place.

No VAT: the owner is VAT exempt in Portugal (art. 53 CIVA exemption). Prices show and charge
with no "+ VAT", the offer box says "VAT exempt under art. 53 CIVA" (`LANDING.vatExempt`) under
the price, and Stripe Tax stays off. `tax_behavior` only matters with Stripe Tax on, so it is
left as is.

### Early-bird price

- The first 4 buyers pay 590 EUR, everyone after 990 EUR: `EARLY_BIRD`
  (`amountCents: 59000`, `spots: 4`) and `priceFor(soldCount)` in `apps/web/src/lib/offer.ts`, which
  returns `amountCents`, `tier` (`"early"` or `"standard"`) and `spotsLeft`. `STANDARD_PRICE` is
  the full price and the fallback.
- The sold count comes from Stripe, there is no database: every session carries metadata
  `offer` (`OFFER.id`, `"reels-8"`), and `countSold` (`apps/web/src/lib/sold-count.ts`) walks
  `checkout.sessions.list({ status: "complete", limit: 100 })` with the SDK's auto-pagination and
  counts the sessions with `status` `complete`, `payment_status` `paid` and that `offer`.
- `currentOfferPrice` (`apps/web/src/lib/offer-price.ts`): the page uses it cached for 60 seconds with
  `unstable_cache` (this app does not opt into Cache Components, and Next 16's guide for that
  setup names `unstable_cache` for non-fetch data). The server action calls it with
  `fresh: true` at checkout time, so the charged amount is always counted again on the server and
  never taken from the client. Under `E2E_MOCK_STRIPE` the cache is skipped so the specs' toggle
  shows at once.
- Any failure (no key, Stripe unreachable) logs and falls back to the full price, on the page and
  at Checkout: a discount that cannot be checked is never shown or charged.
- `buildCheckoutParams` takes the price, sends its `amountCents` as `unit_amount` and records
  metadata `price_tier`. The product name and description do not change.
- The count only sees paid sessions, so two buyers in Checkout at the same time for the last spot
  can both get the early price. Accepted: at most a spot or two over.
- On the page, while spots remain: "590 EUR", the full price struck through next to it
  (`<s>` with an `sr-only` "was"), and "First 4 clients only, N of 4 spots left"
  (`LANDING.earlyBird`). After 4 sold: "990 EUR" alone.

What Checkout shows about the offer:

- `product_data.description` on the line item: `OFFER.description`, one short line (no
  newlines). The full list stays on the landing page's "What you get".
- `product_data.images` on the line item: `<origin>/reels/poster-reel-04.jpg` as a thumbnail, sent
  only when the origin starts with `https://` (`PRODUCT_IMAGE_PATH`). Stripe fetches the image
  itself, so a `http://localhost` origin (dev, E2E) sends no `images` key.
- `branding_settings` on the session (`CHECKOUT_BRANDING`, `SessionCreateParams.BrandingSettings`
  in the stripe 23.0.0 types): `display_name` "edit issebya" (from `LANDING.brand`, shown at the
  top instead of the Stripe account's business name), `background_color` `#ffffff`,
  `button_color` `#a21caf` (Tailwind fuchsia-700, the site's CTA colour), `border_style`
  `rounded`. No `icon` or `logo`: those need an uploaded Stripe File id.
- `custom_text.submit.message` on the session: `LANDING.afterPurchase`, shown next to the Pay
  button. No other `custom_text` key.
- Limits (`STRIPE_DESCRIPTION_MAX_LENGTH`, `STRIPE_CUSTOM_TEXT_MAX_LENGTH`): 40000 characters for
  the description and 1200 for custom text, from Stripe's OpenAPI spec (`maxLength` on
  `POST /v1/checkout/sessions`) and the installed SDK's type comment ("Text can be up to 1200
  characters in length"). The unit test checks both.
- No `consent_collection`: `terms_of_service: "required"` needs a terms URL in the Stripe
  account's public details, or the session create fails. The site's form already requires the
  terms checkbox (`terms_accepted`).

## Tax flag

Off for this owner: she is VAT exempt (art. 53 CIVA), so `STRIPE_AUTOMATIC_TAX` stays unset in
every environment. The support stays in the code for the day she registers for VAT (then the
page copy and the "VAT exempt" line change too).

`STRIPE_AUTOMATIC_TAX` turns Stripe Tax on, and only the exact string `"true"` does
(`automaticTaxEnabled`). Then the session also gets:

- `automatic_tax: { enabled: true }`
- `tax_id_collection: { enabled: true }`
- `customer_creation: "always"`

In payment mode with a new customer, Stripe requires nothing else for tax ID collection
(https://docs.stripe.com/tax/checkout/tax-ids, "New customers"). `customer_creation: "always"` is
the companion we send so the tax ID is saved on a Customer and Stripe reports its VAT verification
result; without a Customer the tax ID stays on the session only.

Unset, or any other value: no tax parameter is sent.

## Failures

- No key: `{ ok: false, error: "unavailable" }`, logged on the server without the answers.
- A thrown Stripe error, or a session without a `url`: the same result, logged the same way.
- Invalid input: `{ ok: false, error: "invalid", fieldErrors }`, shown as field errors with focus on
  the first invalid field.
- The action never throws to the client. On `unavailable` the dialog shows the `role="alert"`
  message, keeps the values and stays on `/`.

## Form dialog layout

- The `<dialog>` has only `max-h-[calc(100dvh-2rem)]` (no height) and is a flex column when
  open. The form and its scrolling body are `min-h-0 flex-auto`, never `flex-1`: with a 0% flex
  basis, Safari's WebKit (iPhone and macOS, Safari 18 era) sized the dialog from the basis and
  showed only the header bar, while Chromium and Playwright's newer WebKit sized it from the
  content. Basis `auto` takes the content size everywhere; `min-h-0` lets the body shrink and
  scroll when the dialog reaches its max height.
- Spec: `apps/web/e2e/dialog_form.spec.ts`, in Chromium and WebKit (the `webkit` project runs only this
  spec; CI installs both browsers). It checks the Name field, the terms checkbox and the
  Continue button are visible inside the viewport at 390x844, 1440x830, 1800x830, 390x480 and
  1440x480, and that the form and its body have `flex-basis: auto`, which catches the collapse
  in every engine.
- On macOS 14 Playwright's own WebKit build is frozen and fails to open a page. In ADW runs
  `.adw/worktree-env` (run by the engine) starts `playwright run-server` in
  `mcr.microsoft.com/playwright:v1.64.0-noble` as `pw-webkit-<adw_id>` on the run's
  `SERVICES_PORT`, forwards the container's `localhost:$PORT` to the host's dev server, and
  exports `PW_WEBKIT_WS`, which `apps/web/playwright.config.ts` reads. Rule: agents never start,
  stop or replace that container, and no port for it is ever fixed.
- By hand, outside ADW, with the dev server running on `$PORT`:

  ```sh
  export PW_WEBKIT_WS="$(ADW_ID=local PORT=<dev port> SERVICES_PORT=<free port> .adw/worktree-env up | sed -n 's/^PW_WEBKIT_WS=//p')"
  yarn workspace @edit-issebya/web test:e2e --project=webkit
  ADW_ID=local .adw/worktree-env down
  ```

- Keep the image tag in step with `@playwright/test` in both apps' `package.json`; a Playwright
  bump changes the tag in `.adw/worktree-env` in the same commit.

## Thank-you dialog

- `/?checkout=success&session_id=...` opens the thank-you dialog from the URL alone.
- It does not retrieve or confirm the session with Stripe, so anyone with the URL can see it, and
  it is not proof of payment. The Stripe Dashboard is the source of truth for who paid.
- Its text (`LANDING.thankYou`) points the buyer to the confirmation email, which the Stripe
  webhook sends after payment (`app_docs/confirmation-email.md`).
- `?checkout=cancelled` shows a short `role="status"` note under the CTA and nothing else.
- Closing the thank-you dialog resets the URL to `/`.

## E2E Stripe mock

- On only when `E2E_MOCK_STRIPE` is exactly `"true"`: set in `apps/web/playwright.config.ts`
  `webServer.env`, or by hand as `E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn dev` for the ADW
  server.
- `apps/web/src/instrumentation.ts` then registers an in-process msw network that answers
  `POST https://api.stripe.com/v1/checkout/sessions` with an id `cs_test_e2e_<uuid>` and the
  success URL as its `url`, and captures the raw request body.
- Under the flag the Stripe client uses `Stripe.createFetchHttpClient()`, so the fetch interceptor
  sees the call. `sk_test_e2e_mock` (`E2E_MOCK_STRIPE_KEY`) stands in when no key is set.
- `/api/e2e-stripe-mock`: `GET` returns the captured body (parsed), `POST { keyMissing }` sets the
  missing-key toggle, `DELETE` clears the capture. Every method answers 404 without the flag.
- The shared state lives on `globalThis` under `Symbol.for` keys (`apps/web/src/lib/e2e-stripe-mock.ts`), so
  every bundle in the server process sees it. That is why specs run with `workers: 1`.
- The create handler also stores each session for the webhook's retrieve and update calls, and
  `/api/e2e-stripe-mock` also lists, clears and sets the payment status of the stored sessions; see
  `app_docs/confirmation-email.md`, "E2E mocks", which also covers the Resend mock.
- The mock also answers `GET https://api.stripe.com/v1/checkout/sessions` (the sold count's
  list call, paginated by `limit` and `starting_after`): `soldCount` paid sessions of the offer
  plus one unpaid and one of another offer, which the count must skip (`listedSessions`).
  `POST { soldCount }` on `/api/e2e-stripe-mock` sets it; `DELETE` resets it to 0, so by default
  the page is in the early-bird state.
- Specs: `apps/web/e2e/checkout.spec.ts`, `apps/web/e2e/call_form.spec.ts`, `apps/web/e2e/confirmation_email.spec.ts`,
  `apps/web/e2e/early_bird.spec.ts`.

### msw 3 deviation

The plan named msw 2's `SetupServerApi` from `msw/node`. The installed `msw` 3.0.3 replaced it, so
the mock uses `defineNetwork` and `InterceptorSource` from `msw/experimental`, with only
`FetchInterceptor` from `@mswjs/interceptors/fetch` (0.45.8), `onUnhandledFrame: "bypass"`, and
every import a `webpackIgnore` dynamic import. Installing only the fetch interceptor keeps clear of
the `ClientRequestInterceptor` passthrough socket bug
(https://github.com/mswjs/interceptors/issues/753). If msw moves `defineNetwork` out of
`experimental`, update the import in `apps/web/src/instrumentation.ts` and this section.

## What the owner configures in Stripe

None of this is done by the code:

1. In Vercel, set `STRIPE_SECRET_KEY`: the live key for Production, a test key for Preview.
2. Stripe Tax: not now. The owner is VAT exempt (art. 53 CIVA), so leave it off and leave
   `STRIPE_AUTOMATIC_TAX` unset. Only if she registers for VAT: enable Stripe Tax (the Lisbon
   origin address, the Portugal registration and any OSS registration, the services tax code as
   the account default), set `STRIPE_AUTOMATIC_TAX=true` in Vercel, redeploy, and change the page
   copy.
3. In Stripe settings (Business, Public details, Branding): the public business name (still used in
   terms, receipts and statements; the Checkout header uses `branding_settings.display_name`), an
   icon or logo, and the support email.
4. In Stripe public details, set the terms of service URL `https://edit.issebya.com/terms` and the
   privacy policy URL `https://edit.issebya.com/privacy`; in Checkout settings, enable "Legal
   policies" and "Contact information" so Checkout links them. Only after this could
   `consent_collection.terms_of_service` be considered (a separate change).
5. Receipt emails for successful payments.
6. Make one test-mode payment and check the Checkout page shows "edit issebya" at the
   top, the thumbnail and the short description next to the product name, and the custom text next
   to the Pay button.

This code has not been run against a real Stripe account.

## Rules

- Never let the shown price and the charged price drift: both come from `OFFER`.
- Never rename a metadata key (`name`, `email`, `socials`, `terms_accepted`, `newsletter`, `offer`, `price_tier`, the five UTM keys and `confirmation_email_sent`). Never change
  `OFFER.id`: the sold count finds the offer's sessions by it.
- Never show "+ VAT" or turn Stripe Tax on while the owner is VAT exempt (art. 53 CIVA).
- Never take the amount from the client: the server action counts the sold spots again at
  checkout time. Never show or charge the early-bird price when the count fails.
- Never pre-tick or require the newsletter box, and never let it change the submit button's
  disabled state. Email a buyer a newsletter only when their `newsletter` metadata is `"true"`.
- Never throw from `startCheckout`; return a typed result.
- Never give the form dialog's flex children a 0% flex basis (`flex-1`): Safari collapses the
  dialog to its header.
- Never create the Stripe client at module load.
- Never copy the offer name, the offer description or the custom text into `checkout-params.ts`;
  the first two are read from `OFFER`, the custom text from `LANDING`.
- Never send `product_data.images` for an origin that is not `https://`.
- Never enable the submit button while the terms box is unticked, and never drop the server-side
  `terms` check because of it.
- Do not send `consent_collection.terms_of_service` unless a terms URL is set in the Stripe
  account's public details.
- Never make the E2E mock, its route or `sk_test_e2e_mock` do anything unless `E2E_MOCK_STRIPE` is
  exactly `"true"`.
- Never commit a real Stripe key.
- Do not treat the thank-you dialog as proof of payment.
