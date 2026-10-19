import { Resend } from "resend";
import Stripe from "stripe";
import { buildBuyerEmail, buildOwnerNotice } from "@/lib/confirmation-email";
import { getConfigMissingToggle, isE2EMockResend } from "@/lib/e2e-resend-mock";
import { getKeyMissingToggle, isE2EMockStripe } from "@/lib/e2e-stripe-mock";
import { createStripeClient } from "@/lib/stripe";
import {
  decideWebhook,
  readEmailConfig,
  SENT_FLAG,
  webhookSecret,
  type EmailConfig,
  type WebhookEnv,
  type WebhookFacts,
} from "@/lib/webhook-config";

/**
 * Stripe webhook: after a paid Checkout Session, sends the owner a notice with
 * the buyer's answers and the buyer the confirmation email, through Resend.
 * See app_docs/confirmation-email.md for the flow and the status table.
 *
 * The signature is checked over the raw body before anything else is read, and
 * nothing is sent before it passes. Once-only delivery without a database: the
 * `confirmation_email_sent` flag on the session (read fresh, written after both
 * emails) plus a Resend idempotency key per session and email. Every path
 * returns a status; logs carry the session id and variable names only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function env(): WebhookEnv {
  return {
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO,
    BOOKING_URL: process.env.BOOKING_URL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    E2E_MOCK_STRIPE: process.env.E2E_MOCK_STRIPE,
    E2E_MOCK_RESEND: process.env.E2E_MOCK_RESEND,
  };
}

function respond(status: number, reason: string): Response {
  return Response.json({ received: status < 300, reason }, { status });
}

// The error's class or code, never its message: a provider message can echo
// an address or other input back.
function errorName(error: unknown): string {
  if (error && typeof error === "object") {
    const { type, code, name } = error as { type?: unknown; code?: unknown; name?: unknown };
    return [type, code, name].filter((part) => typeof part === "string").join(" ") || "unknown";
  }
  return "unknown";
}

async function sendBoth(session: Stripe.Checkout.Session, config: EmailConfig): Promise<void> {
  const metadata = session.metadata ?? {};
  const buyer = session.customer_details?.email || session.customer_email || metadata.email || null;
  if (!buyer) throw Object.assign(new Error("no buyer address"), { code: "no_buyer_address" });

  const resend = new Resend(config.resendKey);
  const owner = buildOwnerNotice({
    sessionId: session.id,
    metadata,
    amountTotal: session.amount_total,
    currency: session.currency,
  });
  const ownerResult = await resend.emails.send(
    {
      from: config.from,
      to: config.replyTo,
      replyTo: buyer,
      subject: owner.subject,
      text: owner.text,
    },
    { idempotencyKey: `owner-notice/${session.id}` },
  );
  if (ownerResult.error) throw ownerResult.error;

  const email = buildBuyerEmail({
    name: metadata.name ?? "",
    bookingUrl: config.bookingUrl,
    termsUrl: config.termsUrl,
  });
  const buyerResult = await resend.emails.send(
    {
      from: config.from,
      to: buyer,
      replyTo: config.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
    },
    { idempotencyKey: `buyer-confirmation/${session.id}` },
  );
  if (buyerResult.error) throw buyerResult.error;
}

export async function POST(request: Request): Promise<Response> {
  const vars = env();
  const secret = webhookSecret(vars);
  // Raw bytes: the signature is over the exact body, so never request.json().
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  let event: Stripe.Event | null = null;
  if (secret && signature) {
    try {
      event = Stripe.webhooks.constructEvent(body, signature, secret);
    } catch {
      event = null;
    }
  }

  const config = readEmailConfig(vars, {
    keyMissing: isE2EMockStripe() && getKeyMissingToggle(),
    configMissing: isE2EMockResend() && getConfigMissingToggle(),
  });
  const facts: WebhookFacts = {
    secretSet: secret !== null,
    signatureValid: event !== null,
    eventType: event?.type ?? "",
    missingConfig: config.ok ? [] : config.missing,
  };

  const first = decideWebhook(facts);
  if (first.action === "respond") {
    if (first.status === 500) {
      console.error("stripe webhook:", first.reason, facts.missingConfig.join(", "));
    } else if (first.status === 400) {
      console.error("stripe webhook: signature verification failed");
    }
    return respond(first.status, first.reason);
  }

  const sessionId = (event?.data.object as { id?: unknown } | undefined)?.id;
  if (typeof sessionId !== "string") return respond(200, "no session id");
  const stripeKey = config.ok ? config.config.stripeKey : config.stripeKey;
  if (!stripeKey) return respond(500, "missing config");

  try {
    // Fresh read: the event is a snapshot, and only the current metadata
    // carries the sent flag.
    const stripe = createStripeClient(stripeKey, isE2EMockStripe());
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const decision = decideWebhook({
      ...facts,
      session: {
        paymentStatus: session.payment_status,
        alreadySent: Boolean(session.metadata?.[SENT_FLAG]),
      },
    });
    if (decision.action === "respond") {
      if (decision.reason === "already sent") {
        console.info("stripe webhook: already sent", sessionId);
      } else if (decision.status === 500) {
        console.error(
          "stripe webhook:",
          decision.reason,
          sessionId,
          facts.missingConfig.join(", "),
        );
      }
      return respond(decision.status, decision.reason);
    }
    if (!config.ok) return respond(500, "missing config");

    await sendBoth(session, config.config);
    try {
      await stripe.checkout.sessions.update(sessionId, {
        metadata: { [SENT_FLAG]: new Date().toISOString() },
      });
    } catch (error) {
      // Both emails are out; a retry within 24 hours is absorbed by the
      // Resend idempotency keys, a later one sends a duplicate once.
      console.error(
        "stripe webhook: emails sent but the sent flag was not written",
        sessionId,
        errorName(error),
      );
      return respond(500, "flag not written");
    }
    return respond(200, "sent");
  } catch (error) {
    console.error("stripe webhook: sending failed", sessionId, errorName(error));
    return respond(500, "send failed");
  }
}
