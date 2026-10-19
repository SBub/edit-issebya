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

// How the Checkout page looks: the brand name at the top instead of the Stripe
// account's business name, a white background and the site's CTA colour
// (Tailwind fuchsia-700) on the Pay button. Field names and values checked
// against the installed SDK types (stripe 23.0.0, Checkout/Sessions.d.ts,
// SessionCreateParams.BrandingSettings).
export const CHECKOUT_BRANDING: Stripe.Checkout.SessionCreateParams.BrandingSettings = {
  display_name: `${LANDING.brand.name} ${LANDING.brand.suffix}`,
  background_color: "#ffffff",
  button_color: "#a21caf",
  border_style: "rounded",
};

// The line item's thumbnail: a reel poster from `public/`. Stripe fetches the
// image itself, so it is sent only for an https origin (never localhost).
export const PRODUCT_IMAGE_PATH = "/reels/poster-reel-04.jpg";

function productImages(origin: string): { images?: string[] } {
  return origin.startsWith("https://") ? { images: [`${origin}${PRODUCT_IMAGE_PATH}`] } : {};
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
          product_data: {
            name: OFFER.productName,
            description: OFFER.description,
            ...productImages(origin),
          },
        },
        quantity: 1,
      },
    ],
    // Shown next to the Pay button: what happens after payment. No
    // consent_collection: requiring terms there needs a terms URL in the
    // Stripe account's public details, and the site's form already requires
    // the terms checkbox.
    custom_text: { submit: { message: LANDING.afterPurchase } },
    branding_settings: CHECKOUT_BRANDING,
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
