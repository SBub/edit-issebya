import { describe, expect, it } from "vitest";
import { formatOfferPrice, OFFER } from "./offer";

describe("formatOfferPrice", () => {
  it("shows the offer price with VAT on top", () => {
    expect(formatOfferPrice()).toBe("990 EUR + VAT");
  });

  it("is derived from the amount, not a second literal", () => {
    expect(formatOfferPrice()).toBe(`${OFFER.amountCents / 100} EUR + VAT`);
    expect(formatOfferPrice({ amountCents: 99000, currency: "eur" })).toBe("990 EUR + VAT");
  });
});
