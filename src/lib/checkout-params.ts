import type Stripe from "stripe";
import { LANDING } from "../content/landing";
import { toCheckoutMetadata, type CallRequest } from "./call-request";
import { OFFER } from "./offer";
import type { Utm } from "./utm";

interface CheckoutInput {
  request: CallRequest;
  utm: Utm;
  // The site's own origin, no trailing slash; both return URLs land on `/`.
  origin: string;
  automaticTax: boolean;
}

// Left literal in success_url: Stripe replaces it with the session id.
export const SESSION_ID_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

// Stripe's limits for the two texts we send. The OpenAPI spec (stripe/openapi,
// spec3.json, POST /v1/checkout/sessions) gives product_data.description
// maxLength 40000 and every custom_text.*.message maxLength 1200; the installed
// SDK types (stripe 23.0.0, Checkout/Sessions.d.ts) say "Text can be up to 1200
// characters in length" for custom_text and give no limit for description.
export const STRIPE_DESCRIPTION_MAX_LENGTH = 40000;
export const STRIPE_CUSTOM_TEXT_MAX_LENGTH = 1200;

// The line item's description on Checkout: the landing page's "What you get"
// items, in order, as one line of sentences. Read from LANDING at call time so
// the page and Checkout never drift. The note on the reel-length item is left
// out because Checkout cannot render its link.
export function offerDescription(): string {
  return LANDING.whatYouGet.items.map((item) => `${item.text}.`).join(" ");
}

// Stripe Tax is opt-in: only the exact string "true" turns it on, so a
// half-configured account never sends tax parameters by accident.
export function automaticTaxEnabled(value: string | undefined): boolean {
  return value === "true";
}

// The Checkout Session for the offer. The form answers and the UTM values
// travel in metadata, so the Stripe Dashboard shows who paid and why.
export function buildCheckoutParams({
  request,
  utm,
  origin,
  automaticTax,
}: CheckoutInput): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: OFFER.currency,
          unit_amount: OFFER.amountCents,
          tax_behavior: "exclusive",
          product_data: { name: OFFER.productName, description: offerDescription() },
        },
        quantity: 1,
      },
    ],
    // Shown next to the Pay button: what happens after payment. No
    // consent_collection: requiring terms there needs a terms URL in the
    // Stripe account's public details, and the site's form already requires
    // the terms checkbox.
    custom_text: { submit: { message: LANDING.afterPurchase } },
    customer_email: request.email,
    metadata: { ...toCheckoutMetadata(request), ...utm },
    success_url: `${origin}/?checkout=success&session_id=${SESSION_ID_PLACEHOLDER}`,
    cancel_url: `${origin}/?checkout=cancelled`,
    ...(automaticTax
      ? {
          automatic_tax: { enabled: true },
          // Payment mode with a new customer needs nothing else for tax ID
          // collection (https://docs.stripe.com/tax/checkout/tax-ids, "New
          // customers"). customer_creation "always" is the optional companion:
          // without a Customer the tax ID stays on the session only and Stripe
          // never sends its VAT verification result.
          tax_id_collection: { enabled: true },
          customer_creation: "always",
        }
      : {}),
  };
}
