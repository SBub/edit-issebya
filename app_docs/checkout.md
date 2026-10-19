# Checkout

The call to action ("Start your 30 days") opens the checkout form. A valid submit creates a Stripe Checkout Session
through a server action and sends the browser to Stripe. After payment Stripe returns to `/`, which
shows a thank-you dialog. The form answers and the UTM values travel in the session's metadata, so
the Stripe Dashboard shows who paid and why.

## Data path

1. The CTA in `src/components/CallRequest.tsx` opens the form dialog (fields in
   `src/components/CallForm.tsx`).
2. The form is `noValidate`. On submit the browser runs `parseCallRequest`
   (`src/lib/call-request.ts`) and shows field errors without calling the server.
3. A valid submit calls the server action `startCheckout` (`src/app/actions.ts`) with the fields
   and the UTM values the page picked from its `searchParams` (`pickUtm`, `src/lib/utm.ts`).
4. The action validates again with the same `parseCallRequest`, picks the UTM values again,
   resolves the key (`stripeSecretKey`, `src/lib/stripe-key.ts`), builds the params
   (`buildCheckoutParams`, `src/lib/checkout-params.ts`) and creates a client for this call only
   (`createStripeClient`, `src/lib/stripe.ts`, `apiVersion` `2026-09-30.endive`, the version
   `stripe` 23.0.0 is typed against).
5. It returns the Checkout URL and the browser navigates there.

Return URLs:

- `success_url`: `<origin>/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
- `cancel_url`: `<origin>/?checkout=cancelled`

The origin is the request's `Origin` header (so an ADW run on its own port lands back on itself),
falling back to `siteUrl` (`src/lib/site-url.ts`: `NEXT_PUBLIC_SITE_URL`, then
`VERCEL_PROJECT_PRODUCTION_URL`, then `http://localhost:3000`).

## Fields and metadata keys

The form asks as little as possible. `CALL_REQUEST_FIELDS`, in order: `name`, `email`, `socials`,
`terms` (`src/lib/call-request.ts`, rendered by `src/components/CallForm.tsx`).

- `name` and `email` are required, trimmed, at most 500 characters; `email` is pattern-checked.
- `socials` is optional: one row to start, more with the + button (up to 10), each removable.
  Empty rows are dropped. A link without a scheme gets `https://` (`instagram.com/you` is what
  people type); anything that is still not an `http(s)` URL with a dotted host is rejected. The
  links, joined one per line, are capped at 500 characters.
- `terms` is a required checkbox linking to `/terms` and `/privacy` (both stubs for now).
- The browser and the action run the same validator, so their messages are identical.

Stripe metadata (`toCheckoutMetadata`): `name`, `email`, `socials` (one link per line, empty when
none), `terms_accepted` (`"true"`), plus the five `UTM_KEYS`: `utm_source`, `utm_medium`,
`utm_campaign`, `utm_term`, `utm_content` (first value of a repeated parameter, trimmed, capped at
500, empty values and unknown keys dropped). `customer_email` is the email.

## Price

`OFFER` in `src/lib/offer.ts`: `amountCents: 99000`, `currency: "eur"`, product name
"8 reels under 1 minute". `buildCheckoutParams` sends it as `price_data` with
`tax_behavior: "exclusive"`. `formatOfferPrice()` renders "990 EUR + VAT" from the same constant,
so the shown price and the charged price come from one place.

## Tax flag

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

## Thank-you dialog

- `/?checkout=success&session_id=...` opens the thank-you dialog from the URL alone.
- It does not retrieve or confirm the session with Stripe (there is no webhook), so anyone with the
  URL can see it. The Stripe Dashboard is the source of truth for who paid.
- `?checkout=cancelled` shows a short `role="status"` note under the CTA and nothing else.
- Closing the thank-you dialog resets the URL to `/`.

## E2E Stripe mock

- On only when `E2E_MOCK_STRIPE` is exactly `"true"`: set in `playwright.config.ts`
  `webServer.env`, or by hand as `E2E_MOCK_STRIPE=true yarn dev` for the ADW server.
- `src/instrumentation.ts` then registers an in-process msw network that answers
  `POST https://api.stripe.com/v1/checkout/sessions` with an id `cs_test_e2e_<uuid>` and the
  success URL as its `url`, and captures the raw request body.
- Under the flag the Stripe client uses `Stripe.createFetchHttpClient()`, so the fetch interceptor
  sees the call. `sk_test_e2e_mock` (`E2E_MOCK_STRIPE_KEY`) stands in when no key is set.
- `/api/e2e-stripe-mock`: `GET` returns the captured body (parsed), `POST { keyMissing }` sets the
  missing-key toggle, `DELETE` clears the capture. Every method answers 404 without the flag.
- The shared state lives on `globalThis` under `Symbol.for` keys (`src/lib/e2e-stripe-mock.ts`), so
  every bundle in the server process sees it. That is why specs run with `workers: 1`.
- Specs: `e2e/checkout.spec.ts`, `e2e/call_form.spec.ts`.

### msw 3 deviation

The plan named msw 2's `SetupServerApi` from `msw/node`. The installed `msw` 3.0.3 replaced it, so
the mock uses `defineNetwork` and `InterceptorSource` from `msw/experimental`, with only
`FetchInterceptor` from `@mswjs/interceptors/fetch` (0.45.8), `onUnhandledFrame: "bypass"`, and
every import a `webpackIgnore` dynamic import. Installing only the fetch interceptor keeps clear of
the `ClientRequestInterceptor` passthrough socket bug
(https://github.com/mswjs/interceptors/issues/753). If msw moves `defineNetwork` out of
`experimental`, update the import in `src/instrumentation.ts` and this section.

## What the owner configures in Stripe

None of this is done by the code:

- `STRIPE_SECRET_KEY` in Vercel: the live key for Production, a test key for Preview.
- Stripe Tax: the Lisbon origin address, the Portugal registration and any OSS registrations, and
  the services tax code as the account default. Then set `STRIPE_AUTOMATIC_TAX=true`.
- Checkout branding and the public business name.
- Receipt emails for successful payments.

This code has not been run against a real Stripe account.

## Rules

- Never let the shown price and the charged price drift: both come from `OFFER`.
- Never rename a metadata key (`name`, `email`, `socials`, `terms_accepted` and the five UTM keys).
- Never throw from `startCheckout`; return a typed result.
- Never create the Stripe client at module load.
- Never make the E2E mock, its route or `sk_test_e2e_mock` do anything unless `E2E_MOCK_STRIPE` is
  exactly `"true"`.
- Never commit a real Stripe key.
- Do not treat the thank-you dialog as proof of payment.
