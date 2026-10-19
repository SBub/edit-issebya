import { describe, expect, it } from "vitest";
import {
  automaticTaxEnabled,
  buildCheckoutParams,
  SESSION_ID_PLACEHOLDER,
} from "./checkout-params";
import type { CallRequest } from "./call-request";
import { OFFER } from "./offer";

const REQUEST: CallRequest = {
  name: "Ana",
  email: "ana@example.com",
  socials: ["https://instagram.com/ana", "https://ana.example.com/"],
  terms: true,
};
const ORIGIN = "https://edit.issebya.com";

function build(automaticTax = false, utm = {}) {
  return buildCheckoutParams({ request: REQUEST, utm, origin: ORIGIN, automaticTax });
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
          product_data: { name: OFFER.productName },
        },
        quantity: 1,
      },
    ]);
    expect(params.customer_email).toBe(REQUEST.email);
  });

  it("carries the answers under their literal keys and no UTM by default", () => {
    const params = build();
    expect(params.metadata).toEqual({
      name: "Ana",
      email: "ana@example.com",
      socials: "https://instagram.com/ana\nhttps://ana.example.com/",
      terms_accepted: "true",
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
