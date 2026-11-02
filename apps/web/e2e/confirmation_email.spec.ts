import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import Stripe from "stripe";
import { CONFIRMATION_EMAIL } from "../src/content/confirmation-email";
import { buildBuyerEmail } from "../src/lib/confirmation-email";
import { E2E_EMAIL_CONFIG, E2E_MOCK_WEBHOOK_SECRET, SENT_FLAG } from "../src/lib/webhook-config";
import { ctaButton, fillValidForm, formDialog, MOCK_ROUTE, VALID_FORM } from "./viewport";

// The Stripe webhook sends the owner notice and the buyer confirmation email
// once per paid session, through the in-process Resend mock
// (E2E_MOCK_RESEND=true), and nothing on a replay, a bad signature, an unpaid
// session or missing config.

const RESEND_ROUTE = "/api/e2e-resend-mock";
const WEBHOOK = "/api/stripe/webhook";

interface RecordedEmail {
  body: {
    from: string;
    to: string | string[];
    reply_to?: string | string[];
    subject: string;
    text: string;
    html?: string;
  };
  idempotencyKey: string | null;
}

interface StoredSession {
  id: string;
  metadata: Record<string, string>;
}

async function emails(request: APIRequestContext): Promise<RecordedEmail[]> {
  return ((await (await request.get(RESEND_ROUTE)).json()) as { emails: RecordedEmail[] }).emails;
}

async function storedSession(request: APIRequestContext, id: string): Promise<StoredSession> {
  const { sessions } = (await (await request.get(MOCK_ROUTE)).json()) as {
    sessions: StoredSession[];
  };
  const session = sessions.find((entry) => entry.id === id);
  expect(session, `stored session ${id}`).toBeDefined();
  return session as StoredSession;
}

// Runs the form through the Stripe mock and returns the session id from the
// landing URL.
async function checkout(page: Page): Promise<string> {
  await page.goto("/?utm_source=test&utm_campaign=spring");
  await ctaButton(page).click();
  const dialog = formDialog(page);
  await fillValidForm(dialog);
  await dialog.getByRole("button", { name: "Continue to payment" }).click();
  await page.waitForURL(/\/\?checkout=success&session_id=cs_test_e2e_/);
  const sessionId = new URL(page.url()).searchParams.get("session_id");
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

function eventPayload(sessionId: string, type = "checkout.session.completed"): string {
  return JSON.stringify({
    id: `evt_e2e_${sessionId}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: sessionId, object: "checkout.session" } },
  });
}

function sign(payload: string, secret = E2E_MOCK_WEBHOOK_SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

function post(request: APIRequestContext, payload: string, signature: string | null) {
  return request.post(WEBHOOK, {
    data: payload,
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "stripe-signature": signature }),
    },
  });
}

test.beforeEach(async ({ request }) => {
  expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
  expect((await request.delete(RESEND_ROUTE)).ok()).toBe(true);
});

test("a paid session gets the buyer email and the owner notice, once, even on replay", async ({
  page,
  request,
}) => {
  const sessionId = await checkout(page);
  const payload = eventPayload(sessionId);
  const signature = sign(payload);

  const response = await post(request, payload, signature);
  expect(response.status()).toBe(200);

  const sent = await emails(request);
  expect(sent).toHaveLength(2);

  const buyer = sent.find((email) => email.idempotencyKey === `buyer-confirmation/${sessionId}`);
  expect(buyer, "buyer email").toBeDefined();
  const expected = buildBuyerEmail({
    name: VALID_FORM.name,
    bookingUrl: E2E_EMAIL_CONFIG.bookingUrl,
    termsUrl: E2E_EMAIL_CONFIG.termsUrl,
  });
  expect(buyer?.body.to).toBe(VALID_FORM.email);
  expect(buyer?.body.from).toBe(E2E_EMAIL_CONFIG.from);
  expect(buyer?.body.reply_to).toBe(E2E_EMAIL_CONFIG.replyTo);
  expect(buyer?.body.subject).toBe(CONFIRMATION_EMAIL.subject);
  expect(buyer?.body.subject).toBe("You're in. Let's book your discovery call");
  expect(buyer?.body.text).toBe(expected.text);
  expect(buyer?.body.text).toContain("Hi Ana Test,\n");
  expect(buyer?.body.text).toContain("👉 Book your call: https://booking.e2e.test/call");
  expect(buyer?.body.html).toContain('href="https://booking.e2e.test/call"');
  // The durable record of the request to start right away (DL 24/2014 art. 15).
  expect(buyer?.body.text).toContain(
    "Work starts right away. See https://site.e2e.test/terms#withdrawal for cancellations",
  );

  const owner = sent.find((email) => email.idempotencyKey === `owner-notice/${sessionId}`);
  expect(owner, "owner notice").toBeDefined();
  expect(owner?.body.to).toBe(E2E_EMAIL_CONFIG.replyTo);
  expect(owner?.body.from).toBe(E2E_EMAIL_CONFIG.from);
  expect(owner?.body.reply_to).toBe(VALID_FORM.email);
  expect(owner?.body.subject).toBe(`New payment: ${VALID_FORM.name}`);
  for (const value of [
    VALID_FORM.name,
    VALID_FORM.email,
    "https://instagram.com/ana",
    "https://ana.example.com/",
    "utm_source: test",
    "utm_campaign: spring",
    sessionId,
  ]) {
    expect(owner?.body.text).toContain(value);
  }

  expect((await storedSession(request, sessionId)).metadata[SENT_FLAG]).toBeTruthy();

  // Replay: the identical delivery, then a freshly signed copy.
  expect((await post(request, payload, signature)).status()).toBe(200);
  expect((await post(request, payload, sign(payload))).status()).toBe(200);
  expect(await emails(request)).toHaveLength(2);
});

test("async_payment_succeeded sends the emails too", async ({ page, request }) => {
  const sessionId = await checkout(page);
  const payload = eventPayload(sessionId, "checkout.session.async_payment_succeeded");
  expect((await post(request, payload, sign(payload))).status()).toBe(200);
  expect(await emails(request)).toHaveLength(2);
});

test("a bad or missing signature is rejected and sends nothing", async ({ page, request }) => {
  const sessionId = await checkout(page);
  const payload = eventPayload(sessionId);

  expect((await post(request, payload, sign(payload, "whsec_wrong"))).status()).toBe(400);
  expect((await post(request, payload, null)).status()).toBe(400);

  expect(await emails(request)).toHaveLength(0);
  expect((await storedSession(request, sessionId)).metadata).not.toHaveProperty(SENT_FLAG);
});

test("an unpaid session gets no email", async ({ page, request }) => {
  const sessionId = await checkout(page);
  const seeded = await request.post(MOCK_ROUTE, { data: { sessionId, paymentStatus: "unpaid" } });
  expect(seeded.ok()).toBe(true);

  const payload = eventPayload(sessionId);
  expect((await post(request, payload, sign(payload))).status()).toBe(200);
  expect(await emails(request)).toHaveLength(0);
  expect((await storedSession(request, sessionId)).metadata).not.toHaveProperty(SENT_FLAG);
});

test("missing config answers 500 and the retry after the fix delivers", async ({
  page,
  request,
}) => {
  const sessionId = await checkout(page);
  const payload = eventPayload(sessionId);
  expect((await request.post(RESEND_ROUTE, { data: { configMissing: true } })).ok()).toBe(true);
  try {
    expect((await post(request, payload, sign(payload))).status()).toBe(500);
    expect(await emails(request)).toHaveLength(0);
    expect((await storedSession(request, sessionId)).metadata).not.toHaveProperty(SENT_FLAG);
  } finally {
    await request.post(RESEND_ROUTE, { data: { configMissing: false } });
  }
  expect((await post(request, payload, sign(payload))).status()).toBe(200);
  expect(await emails(request)).toHaveLength(2);
  expect((await storedSession(request, sessionId)).metadata[SENT_FLAG]).toBeTruthy();
});

test("an unhandled event type is acknowledged and sends nothing", async ({ request }) => {
  const payload = eventPayload("cs_test_unknown", "invoice.paid");
  expect((await post(request, payload, sign(payload))).status()).toBe(200);
  expect(await emails(request)).toHaveLength(0);
});
