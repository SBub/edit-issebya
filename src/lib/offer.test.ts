import { describe, expect, it } from "vitest";
import { LANDING } from "../content/landing";
import {
  EARLY_BIRD,
  formatOfferPrice,
  OFFER,
  priceFor,
  reelSlotsFor,
  STANDARD_PRICE,
} from "./offer";

describe("formatOfferPrice", () => {
  it("shows the offer price with no VAT (the owner is VAT exempt)", () => {
    expect(formatOfferPrice()).toBe("990 EUR");
    expect(formatOfferPrice()).not.toContain("VAT");
  });

  it("is derived from the amount, not a second literal", () => {
    expect(formatOfferPrice()).toBe(`${OFFER.amountCents / 100} EUR`);
    expect(formatOfferPrice({ amountCents: 99000, currency: "eur" })).toBe("990 EUR");
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
      "590 EUR",
    );
  });
});

describe("the offer facts the terms render", () => {
  it("match the landing copy, so the page and the terms never drift", () => {
    const texts = [
      ...LANDING.whatYouGet.items.map((item) => item.text),
      ...LANDING.howItWorks.steps,
    ];
    expect(texts.some((text) => text.includes(`${OFFER.reelCount} reels`))).toBe(true);
    expect(texts.some((text) => text.includes(`${OFFER.footageDays} days`))).toBe(true);
    expect(texts.some((text) => text.includes(`${OFFER.deliveryHours} hours`))).toBe(true);
    expect(texts.some((text) => text.includes(`under ${OFFER.maxSeconds / 60} min`))).toBe(true);
  });

  it("counts a longer reel as one reel per started minute", () => {
    expect(reelSlotsFor(0)).toBe(1);
    expect(reelSlotsFor(45)).toBe(1);
    expect(reelSlotsFor(60)).toBe(1);
    expect(reelSlotsFor(61)).toBe(2);
    expect(reelSlotsFor(120)).toBe(2);
    expect(reelSlotsFor(121)).toBe(3);
    expect(reelSlotsFor(130)).toBe(3);
    expect(reelSlotsFor(180)).toBe(3);
  });
});
