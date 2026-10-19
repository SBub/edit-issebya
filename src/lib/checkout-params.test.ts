import { describe, expect, it } from "vitest";
import { LANDING } from "../content/landing";
import {
  automaticTaxEnabled,
  buildCheckoutParams,
  CHECKOUT_BRANDING,
  PRODUCT_IMAGE_PATH,
  SESSION_ID_PLACEHOLDER,
  STRIPE_CUSTOM_TEXT_MAX_LENGTH,
  STRIPE_DESCRIPTION_MAX_LENGTH,
} from "./checkout-params";
import type { CallRequest } from "./call-request";
import { OFFER } from "./offer";

const REQUEST: CallRequest = {
  name: "Ana",
  email: "ana@example.com",
  socials: ["https://instagram.com/ana", "https://ana.example.com/"],
  terms: true,
  newsletter: false,
};
const ORIGIN = "https://edit.issebya.com";

function build(automaticTax = false, utm = {}, origin = ORIGIN) {
  return buildCheckoutParams({ request: REQUEST, utm, origin, automaticTax });
}

describe("the Checkout params builder", () => {
  it("charges the offer price, tax-exclusive, once", () => {
    const params = build();
    expect(params.mode).toBe("payment");
    expect(params.line_items).toEqual([
      {
        price_data: {
          currency: OFFER.currency,
          unit_amount: OFFER.amountCents,
          tax_behavior: "exclusive",
          product_data: {
            name: OFFER.productName,
            description: OFFER.description,
            images: [`${ORIGIN}/reels/poster-reel-04.jpg`],
          },
        },
        quantity: 1,
      },
    ]);
    expect(params.customer_email).toBe(REQUEST.email);
  });

  it("names the offer briefly, with a one-line description", () => {
    expect(OFFER.productName).toBe("8 reels, each under 1 minute");
    expect(OFFER.description).toBe("Visual identity, recording guide and 30 days to send footage");
    expect(OFFER.description).not.toContain("\n");
    expect(OFFER.description.length).toBeLessThanOrEqual(STRIPE_DESCRIPTION_MAX_LENGTH);
  });

  it("shows a poster thumbnail only for an https origin", () => {
    expect(PRODUCT_IMAGE_PATH).toBe("/reels/poster-reel-04.jpg");
    const https = build(false, {}, "https://edit.issebya.com");
    expect(https.line_items?.[0]?.price_data?.product_data?.images).toEqual([
      "https://edit.issebya.com/reels/poster-reel-04.jpg",
    ]);
    for (const origin of ["http://localhost:3000", "http://edit.issebya.com"]) {
      const params = build(false, {}, origin);
      expect(params.line_items?.[0]?.price_data?.product_data).not.toHaveProperty("images");
    }
  });

  it("brands the Checkout page with the site name and CTA colour", () => {
    expect(CHECKOUT_BRANDING).toEqual({
      display_name: "edit issebya",
      background_color: "#ffffff",
      button_color: "#a21caf",
      border_style: "rounded",
    });
    expect(build(false).branding_settings).toEqual(CHECKOUT_BRANDING);
    expect(build(true).branding_settings).toEqual(CHECKOUT_BRANDING);
    expect(build(false, {}, "http://localhost:3000").branding_settings).toEqual(CHECKOUT_BRANDING);
  });

  it("says what happens after payment next to the Pay button", () => {
    const params = build();
    expect(params.custom_text).toEqual({ submit: { message: LANDING.afterPurchase } });
    expect(LANDING.afterPurchase.length).toBeLessThanOrEqual(STRIPE_CUSTOM_TEXT_MAX_LENGTH);
  });

  it("never asks Stripe for terms consent, with tax on or off", () => {
    expect(build(false)).not.toHaveProperty("consent_collection");
    expect(build(true)).not.toHaveProperty("consent_collection");
  });

  it("carries the answers under their literal keys and no UTM by default", () => {
    const params = build();
    expect(params.metadata).toEqual({
      name: "Ana",
      email: "ana@example.com",
      socials: "https://instagram.com/ana\nhttps://ana.example.com/",
      terms_accepted: "true",
      newsletter: "false",
    });
  });

  it("sends an empty socials value when the buyer has none", () => {
    const params = buildCheckoutParams({
      request: { ...REQUEST, socials: [] },
      utm: {},
      origin: ORIGIN,
      automaticTax: false,
    });
    expect(params.metadata).toMatchObject({ socials: "" });
  });

  it("adds the given UTM values to metadata", () => {
    const params = build(false, { utm_source: "ig", utm_campaign: "spring" });
    expect(params.metadata).toMatchObject({ utm_source: "ig", utm_campaign: "spring" });
    expect(params.metadata).not.toHaveProperty("utm_medium");
  });

  it("returns to / with the session id placeholder left literal", () => {
    const params = build();
    expect(SESSION_ID_PLACEHOLDER).toBe("{CHECKOUT_SESSION_ID}");
    expect(params.success_url).toBe(
      `${ORIGIN}/?checkout=success&session_id=${SESSION_ID_PLACEHOLDER}`,
    );
    expect(params.cancel_url).toBe(`${ORIGIN}/?checkout=cancelled`);
  });

  it("sends no tax parameters unless automatic tax is on", () => {
    const params = build(false);
    expect(params).not.toHaveProperty("automatic_tax");
    expect(params).not.toHaveProperty("tax_id_collection");
    expect(params).not.toHaveProperty("customer_creation");
  });

  it("sends automatic tax, tax ID collection and customer creation when on", () => {
    const params = build(true);
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.customer_creation).toBe("always");
  });
});

describe("automaticTaxEnabled", () => {
  it("is on only for the exact string true", () => {
    expect(automaticTaxEnabled("true")).toBe(true);
    for (const value of [undefined, "", "TRUE", "1", "yes", " true"]) {
      expect(automaticTaxEnabled(value)).toBe(false);
    }
  });
});
