import type Stripe from "stripe";
import type { CallRequest } from "./call-request";
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

// Stripe Tax is opt-in: only the exact string "true" turns it on, so a
// half-configured account never sends tax parameters by accident.
export function automaticTaxEnabled(value: string | undefined): boolean {
  return value === "true";
}

// The Checkout Session for one discovery call. The answers and the UTM values
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
          product_data: { name: OFFER.productName },
        },
        quantity: 1,
      },
    ],
    customer_email: request.email,
    metadata: { ...request, ...utm },
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
