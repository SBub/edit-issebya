import { stripeSecretKey } from "./stripe-key";

// What the Stripe webhook needs before it can send the confirmation emails,
// and the pure decision of what it answers. The route
// (src/app/api/stripe/webhook/route.ts) gathers the facts; this module says
// which status they earn. A 2xx is final for Stripe, so it is returned only
// when it is safe to forget the event.

// Never real values: under the E2E flags the mocks intercept every call.
export const E2E_MOCK_WEBHOOK_SECRET = "whsec_e2e_mock";
export const E2E_MOCK_RESEND_KEY = "re_e2e_mock";
export const E2E_EMAIL_CONFIG = {
  from: "E2E Sender <from@e2e.test>",
  replyTo: "owner@e2e.test",
  bookingUrl: "https://booking.e2e.test/call",
} as const;

// The one metadata key the code writes: an ISO timestamp, set on the session
// after both emails are accepted.
export const SENT_FLAG = "confirmation_email_sent";

const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
] as const;

export interface WebhookEnv {
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  BOOKING_URL?: string;
  E2E_MOCK_STRIPE?: string;
  E2E_MOCK_RESEND?: string;
}

/** The secret the signature is checked against, or null when none is set. */
export function webhookSecret(env: WebhookEnv): string | null {
  // Always the literal under the flag, so a developer's .env.local cannot
  // break the specs. Never outside it.
  if (env.E2E_MOCK_STRIPE === "true") return E2E_MOCK_WEBHOOK_SECRET;
  return env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

function isHttpsUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  return new URL(value).protocol === "https:";
}

export interface EmailConfig {
  stripeKey: string;
  resendKey: string;
  from: string;
  replyTo: string;
  bookingUrl: string;
}

// The Stripe key travels on the failure too: the webhook still needs it to
// read the session (an already-sent or unpaid session answers 200 whatever
// else is missing).
export type EmailConfigResult =
  { ok: true; config: EmailConfig } | { ok: false; missing: string[]; stripeKey: string | null };

/**
 * Reads the Stripe key, the Resend key, the sender, the reply-to and the
 * booking link. Reports every missing name (never a value); a BOOKING_URL that
 * is not an https URL counts as missing. Under E2E_MOCK_RESEND the Resend key
 * falls back to the mock key and the addresses and link are fixed, and the
 * configMissing toggle makes BOOKING_URL missing.
 */
export function readEmailConfig(
  env: WebhookEnv,
  toggles: { keyMissing: boolean; configMissing: boolean },
): EmailConfigResult {
  const mockResend = env.E2E_MOCK_RESEND === "true";
  const stripeKey = stripeSecretKey(env, toggles.keyMissing);
  const resendKey = env.RESEND_API_KEY?.trim() || (mockResend ? E2E_MOCK_RESEND_KEY : "");
  const from = mockResend ? E2E_EMAIL_CONFIG.from : (env.EMAIL_FROM?.trim() ?? "");
  const replyTo = mockResend ? E2E_EMAIL_CONFIG.replyTo : (env.EMAIL_REPLY_TO?.trim() ?? "");
  const bookingUrl =
    mockResend && toggles.configMissing
      ? ""
      : mockResend
        ? E2E_EMAIL_CONFIG.bookingUrl
        : (env.BOOKING_URL?.trim() ?? "");

  const missing: string[] = [];
  if (!stripeKey) missing.push("STRIPE_SECRET_KEY");
  if (!resendKey) missing.push("RESEND_API_KEY");
  if (!from) missing.push("EMAIL_FROM");
  if (!replyTo) missing.push("EMAIL_REPLY_TO");
  if (!isHttpsUrl(bookingUrl)) missing.push("BOOKING_URL");

  if (missing.length > 0 || !stripeKey) return { ok: false, missing, stripeKey };
  return { ok: true, config: { stripeKey, resendKey, from, replyTo, bookingUrl } };
}

export interface WebhookFacts {
  secretSet: boolean;
  signatureValid: boolean;
  eventType: string;
  // The variable names readEmailConfig reported missing.
  missingConfig: readonly string[];
  // Known only after the session is retrieved; undefined before.
  session?: { paymentStatus: string; alreadySent: boolean };
}

export type WebhookDecision =
  | { action: "respond"; status: 200 | 400 | 500; reason: string }
  | { action: "retrieve" }
  | { action: "send" };

/**
 * Which status the facts earn, in the route's order: no secret 500, bad
 * signature 400, unhandled type 200, no Stripe key 500 (the session cannot be
 * read), then on the fresh session: not paid 200, already sent 200, any other
 * missing variable 500, else send.
 */
export function decideWebhook(facts: WebhookFacts): WebhookDecision {
  if (!facts.secretSet) return { action: "respond", status: 500, reason: "no webhook secret" };
  if (!facts.signatureValid) return { action: "respond", status: 400, reason: "bad signature" };
  if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(facts.eventType)) {
    return { action: "respond", status: 200, reason: "event type not handled" };
  }
  if (facts.missingConfig.includes("STRIPE_SECRET_KEY")) {
    return { action: "respond", status: 500, reason: "missing config" };
  }
  if (!facts.session) return { action: "retrieve" };
  if (facts.session.paymentStatus !== "paid") {
    return { action: "respond", status: 200, reason: "not paid yet" };
  }
  if (facts.session.alreadySent) return { action: "respond", status: 200, reason: "already sent" };
  if (facts.missingConfig.length > 0) {
    return { action: "respond", status: 500, reason: "missing config" };
  }
  return { action: "send" };
}
