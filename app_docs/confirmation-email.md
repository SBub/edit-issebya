# Confirmation email

After a successful payment the buyer gets a confirmation email with a link to book the discovery
call, and the owner gets a separate notice with the buyer's form answers. A Stripe webhook triggers
both; Resend sends them. No database: a flag on the Stripe session plus Resend idempotency keys keep
it to one email per payment.

This has not been run against real Stripe or Resend accounts.

## Flow

`POST /api/stripe/webhook` (`apps/web/src/app/api/stripe/webhook/route.ts`, Node runtime), in this order:

1. Read the raw body with `request.text()` and the `stripe-signature` header. Never `request.json()`:
   the signature is over the exact bytes.
2. Verify with `Stripe.webhooks.constructEvent(body, header, secret)`. Bad or missing signature:
   400, logged, nothing sent.
3. Handle `checkout.session.completed` and `checkout.session.async_payment_succeeded` (a delayed
   method such as SEPA Debit completes the session unpaid and pays later). Any other type: 200.
4. Retrieve the session fresh (`checkout.sessions.retrieve`, client from `createStripeClient`,
   created per request). The event is a snapshot; only the current metadata carries the sent flag.
5. `payment_status !== "paid"`: 200, no-op (the `async_payment_succeeded` event will come).
6. `metadata.confirmation_email_sent` set: 200, no-op, logged as `already sent` with the session id.
7. Config check (below). Anything missing: 500, nothing sent.
8. Send the owner notice, then the buyer email, each with a Resend idempotency key:
   `owner-notice/<session_id>` and `buyer-confirmation/<session_id>`. Buyer address:
   `customer_details.email`, then `customer_email`, then `metadata.email`.
9. `checkout.sessions.update(id, { metadata: { confirmation_email_sent: <ISO timestamp> } })`. Stripe
   merges metadata keys, so the form keys are untouched.
10. 200.

Any Stripe or Resend error in steps 4 to 9: 500, logged with the session id and the error's class
or code (never its message), so Stripe retries.

The status rules are the pure `decideWebhook` (`apps/web/src/lib/webhook-config.ts`), unit-tested row by
row; the route only gathers the facts.

## Statuses

Stripe treats any non-2xx as a failure and retries for up to 3 days in live mode, emailing the
account owner about a failing endpoint. A 2xx is final.

| situation                                                                              | status |
| -------------------------------------------------------------------------------------- | ------ |
| `STRIPE_WEBHOOK_SECRET` missing                                                        | 500    |
| bad or missing signature                                                               | 400    |
| event type not handled                                                                 | 200    |
| `STRIPE_SECRET_KEY` missing (the session cannot be read)                               | 500    |
| session not paid yet                                                                   | 200    |
| sent flag already set                                                                  | 200    |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` missing, or `BOOKING_URL` not `https` | 500    |
| both emails accepted and the flag written                                              | 200    |
| any Stripe or Resend error, including the flag write                                   | 500    |

Missing config is a 500 so the retries and Stripe's failing-endpoint email are the alarm: the owner
fixes the variable in Vercel, redeploys, and the next retry sends the email. Each missing name is
logged (`console.error`, names only, never values).

## Idempotency

- **Session metadata flag** `confirmation_email_sent`: the durable record. Checked on a fresh
  retrieve before sending, written after both emails are accepted. Covers retries and manual
  resends at any distance in time; the owner sees it in the Dashboard.
- **Resend idempotency keys** (`idempotencyKey` request option, sent as the `Idempotency-Key`
  header by `resend` 6.34.1): cover two deliveries racing before the flag is written, and a retry
  after a partial failure. Resend keeps a key for 24 hours and rejects a reused key with a
  different payload (409 `invalid_idempotent_request`,
  https://resend.com/docs/dashboard/emails/idempotency-keys), so the bodies are deterministic: no
  timestamps or random ids.
- **The one accepted hole**: both emails sent, the flag write fails, and Stripe's next retry lands
  more than 24 hours later. That sends a duplicate once. It is logged as an error.

## The emails

- Copy: `apps/web/src/content/confirmation-email.ts`, the owner's literal wording, read by the builder
  (`apps/web/src/lib/confirmation-email.ts`), its unit test and the e2e spec.
- Buyer: subject `You're in. Let's book your discovery call`, from `EMAIL_FROM`, to the buyer,
  reply-to `EMAIL_REPLY_TO`. Plain text is the copy with `[Name]` (the trimmed `metadata.name`)
  and `👉 Book your call: <BOOKING_URL>`, and, before the sign-off, "Work starts right away. See <site>/terms#withdrawal for
  cancellations" ( `termsUrl` in
  `readEmailConfig`, built from `siteUrl`, fixed to `https://site.e2e.test/terms#withdrawal`
  under `E2E_MOCK_RESEND`). HTML is the same text in `<p>`, `<ul>`, `<ol>`, `<strong>` for the
  three headings and two `<a>`s (booking, and the terms URL shown as its own text), with the name escaped. No
  images, no tracking, no external CSS.
- Owner: a separate email (not a CC), from `EMAIL_FROM`, to `EMAIL_REPLY_TO`, reply-to the buyer,
  subject `New payment: <name>`. Plain text: each metadata key and value in `CALL_REQUEST_FIELDS`
  order (`terms` as `terms_accepted`), then `newsletter`, then `UTM_KEYS` order, socials one link per line, then the
  session id, `amount_total` and `currency`. Nothing else.

## Variables

Server-only, all optional at build time (`yarn build` passes with none set):

| variable                | example                          | used for                                     |
| ----------------------- | -------------------------------- | -------------------------------------------- |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`                      | verifying the signature                      |
| `STRIPE_SECRET_KEY`     | `sk_live_...`                    | reading and flagging the session             |
| `RESEND_API_KEY`        | `re_...`                         | sending                                      |
| `EMAIL_FROM`            | `Sveta <sveta@edit.issebya.com>` | sender of both emails                        |
| `EMAIL_REPLY_TO`        | `sveta@issebya.com`              | reply-to of the buyer email, owner notice to |
| `BOOKING_URL`           | `https://cal.com/...`            | the "Book your call" link; must be `https`   |

## E2E mocks

Both run in the msw network `apps/web/src/instrumentation.ts` starts when either flag is exactly `"true"`;
each flag adds only its own handlers. `apps/web/playwright.config.ts` sets both in `webServer.env`; the ADW
server starts as `E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn dev`.

- **Stripe** (`E2E_MOCK_STRIPE`): the create handler also stores the session by id
  (`apps/web/src/lib/e2e-stripe-mock.ts`: metadata from the body, `customer_email`,
  `customer_details.email`, `payment_status: "paid"`, `amount_total`, `currency`).
  `GET .../checkout/sessions/:id` returns it (Stripe's 404 shape when unknown);
  `POST .../checkout/sessions/:id` merges `metadata[...]` into it. Under the flag the webhook
  always verifies with `whsec_e2e_mock`, even if `STRIPE_WEBHOOK_SECRET` is set.
  `/api/e2e-stripe-mock`: `GET` also returns the sessions, `DELETE` also clears them,
  `POST { sessionId, paymentStatus }` sets one session's `payment_status`.
- **Resend** (`E2E_MOCK_RESEND`): `POST https://api.resend.com/emails` (the SDK uses the global
  `fetch`) records the JSON body and the `Idempotency-Key` header (`apps/web/src/lib/e2e-resend-mock.ts`).
  It does not emulate idempotency, so the replay spec proves the metadata flag. Under the flag the
  Resend key falls back to `re_e2e_mock`, and the sender, reply-to and booking link are always
  `E2E Sender <from@e2e.test>`, `owner@e2e.test` and `https://booking.e2e.test/call`.
  `/api/e2e-resend-mock`: `GET` the recorded list, `DELETE` clears it, `POST { configMissing }`
  makes the webhook treat `BOOKING_URL` as missing.
- Specs: `apps/web/e2e/confirmation_email.spec.ts` (happy path, replay, bad and missing signature, unpaid,
  missing config then retry, unhandled type). Events are signed with
  `Stripe.webhooks.generateTestHeaderString`.

## Owner steps

None of this is done by the code:

1. Choose a booking tool (e.g. Cal.com), create a discovery-call event type, and set `BOOKING_URL`
   to its public link.
2. In Resend, add and verify the sending domain (DNS records for `edit.issebya.com` or
   `issebya.com`), create an API key with sending access, and decide `EMAIL_FROM` on that domain.
3. In Stripe (live and test separately), add a webhook endpoint
   `https://edit.issebya.com/api/stripe/webhook` with events `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`, and copy its signing secret.
4. In Vercel, set `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`,
   `BOOKING_URL` for Production (test-mode values for Preview if wanted), then redeploy.
5. Make one test-mode payment and check both emails arrive, then resend the event from the Stripe
   Dashboard and check nothing new arrives.

## Rules

- The email copy is literal. Never reword it without the owner; the unit test compares the full
  plain-text body character for character.
- Never send before the signature is verified, and never read the body as JSON before verifying.
- Never answer 2xx for an event whose email was not sent, unless sending is not needed (not paid,
  already flagged, other event type).
- Never add a database, a queue or a KV store.
- Never rename or remove an existing metadata key. `confirmation_email_sent` is the only key the
  code writes.
- Never create a Stripe or Resend client at module load.
- Never put form answers or email bodies in logs or in PostHog. Logs carry the session id, variable
  names and error classes only.
- Never put a timestamp or a random id in an email body: Resend rejects a reused idempotency key
  with a different payload.
- Never make the mocks, their routes or the `whsec_e2e_mock` and `re_e2e_mock` fallbacks do
  anything unless their flag is exactly `"true"`. In production both mock routes answer 404.
- Never commit a real key or send a real email from a test.
