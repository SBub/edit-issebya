"use server";

import { headers } from "next/headers";
import { parseCallRequest, type CallRequestErrors } from "@/lib/call-request";
import { automaticTaxEnabled, buildCheckoutParams } from "@/lib/checkout-params";
import { currentOfferPrice } from "@/lib/offer-price";
import { getKeyMissingToggle, isE2EMockStripe } from "@/lib/e2e-stripe-mock";
import { siteUrl } from "@/lib/site-url";
import { createStripeClient } from "@/lib/stripe";
import { stripeSecretKey } from "@/lib/stripe-key";
import { pickUtm } from "@/lib/utm";

export type StartCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: "invalid"; fieldErrors: CallRequestErrors }
  | { ok: false; error: "unavailable" };

// The request's own origin, so the return URLs land on the server that served
// the page (an ADW run is never on port 3000). Next already rejects a server
// action whose Origin does not match its Host. Falls back to siteUrl.
async function requestOrigin(): Promise<string> {
  const origin = (await headers()).get("origin");
  if (origin && URL.canParse(origin)) {
    const url = new URL(origin);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  }
  return siteUrl({
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
}

/**
 * Validates the form answers again, then creates a Stripe Checkout
 * Session carrying them and the UTM values in its metadata. Never throws to the
 * client: every failure is a typed result, and errors are logged here without
 * the answers.
 */
export async function startCheckout(input: {
  fields: Record<string, unknown>;
  utm: Record<string, string>;
}): Promise<StartCheckoutResult> {
  const parsed = parseCallRequest(input?.fields ?? {});
  if (!parsed.ok) return { ok: false, error: "invalid", fieldErrors: parsed.errors };

  const mock = isE2EMockStripe();
  const key = stripeSecretKey(
    {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      E2E_MOCK_STRIPE: process.env.E2E_MOCK_STRIPE,
    },
    getKeyMissingToggle(),
  );
  if (!key) {
    console.error("startCheckout: no Stripe secret key is configured");
    return { ok: false, error: "unavailable" };
  }

  try {
    const params = buildCheckoutParams({
      request: parsed.value,
      utm: pickUtm(input?.utm ?? {}),
      origin: await requestOrigin(),
      automaticTax: automaticTaxEnabled(process.env.STRIPE_AUTOMATIC_TAX),
      // Counted again now, uncached: the early-bird price is enforced here.
      price: await currentOfferPrice({ fresh: true }),
    });
    const session = await createStripeClient(key, mock).checkout.sessions.create(params);
    if (!session.url) {
      console.error("startCheckout: Stripe returned a session without a url", session.id);
      return { ok: false, error: "unavailable" };
    }
    return { ok: true, url: session.url };
  } catch (error) {
    console.error("startCheckout: creating the Checkout Session failed", error);
    return { ok: false, error: "unavailable" };
  }
}
