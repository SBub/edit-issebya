import { describe, expect, it } from "vitest";
import { EARLY_BIRD, formatOfferPrice, OFFER, priceFor, STANDARD_PRICE } from "./offer";

describe("formatOfferPrice", () => {
  it("shows the offer price with VAT on top", () => {
    expect(formatOfferPrice()).toBe("990 EUR + VAT");
  });

  it("is derived from the amount, not a second literal", () => {
    expect(formatOfferPrice()).toBe(`${OFFER.amountCents / 100} EUR + VAT`);
    expect(formatOfferPrice({ amountCents: 99000, currency: "eur" })).toBe("990 EUR + VAT");
  });
});

describe("priceFor", () => {
  it("gives the early-bird price to the first 4 buyers", () => {
    expect(EARLY_BIRD).toEqual({ amountCents: 59000, spots: 4 });
    expect(priceFor(0)).toEqual({ amountCents: 59000, tier: "early", spotsLeft: 4 });
    expect(priceFor(3)).toEqual({ amountCents: 59000, tier: "early", spotsLeft: 1 });
  });

  it("gives the full price from the 5th buyer on", () => {
    expect(priceFor(4)).toEqual({ amountCents: 99000, tier: "standard", spotsLeft: 0 });
    expect(priceFor(5)).toEqual({ amountCents: 99000, tier: "standard", spotsLeft: 0 });
    expect(priceFor(4)).toEqual(STANDARD_PRICE);
  });

  it("never discounts on a count it cannot trust", () => {
    expect(priceFor(Number.NaN)).toEqual(STANDARD_PRICE);
    expect(priceFor(Number.POSITIVE_INFINITY)).toEqual(STANDARD_PRICE);
    expect(priceFor(-2)).toEqual({ amountCents: 59000, tier: "early", spotsLeft: 4 });
  });

  it("formats the early-bird price like the full one", () => {
    expect(formatOfferPrice({ amountCents: EARLY_BIRD.amountCents, currency: "eur" })).toBe(
      "590 EUR + VAT",
    );
  });
});
