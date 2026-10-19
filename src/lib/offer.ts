// The one offer the page sells. The owner is VAT exempt in Portugal (art. 53
// CIVA), so the amount is the whole price: no VAT is shown or charged, and
// Stripe Tax stays off (STRIPE_AUTOMATIC_TAX unset). The shown price and the
// charged price both come from this constant, so they cannot drift apart.
export const OFFER = {
  // Stamped on every Checkout Session as metadata `offer`, so the sold count
  // only counts this offer's sessions. Never rename it.
  id: "reels-8",
  amountCents: 99000,
  currency: "eur",
  // The line item on Stripe Checkout: a short name and a one-line description,
  // so the Checkout page reads like a product, not a paragraph.
  productName: "8 reels, each under 1 minute",
  description: "Visual identity, recording guide and 30 days to send footage",
  reelCount: 8,
  maxSeconds: 60,
} as const;

// "990 EUR", derived from the amount. No thousands separator, so the
// rendered text is exactly what the specs look for.
export function formatOfferPrice(offer: { amountCents: number; currency: string } = OFFER): string {
  return `${offer.amountCents / 100} ${offer.currency.toUpperCase()}`;
}

// The early-bird price: the first `spots` paid sessions of this offer pay
// `amountCents`, everyone after pays OFFER.amountCents.
export const EARLY_BIRD = { amountCents: 59000, spots: 4 } as const;

export type PriceTier = "early" | "standard";

export interface OfferPrice {
  amountCents: number;
  tier: PriceTier;
  // Early-bird spots still open; 0 at the standard price.
  spotsLeft: number;
}

// The full price, also the fallback whenever the sold count is unknown: never
// show or charge a discount that cannot be checked.
export const STANDARD_PRICE: OfferPrice = {
  amountCents: OFFER.amountCents,
  tier: "standard",
  spotsLeft: 0,
};

// The price for the next buyer, given how many have paid already.
export function priceFor(soldCount: number): OfferPrice {
  const sold = Number.isFinite(soldCount) ? Math.max(0, Math.floor(soldCount)) : EARLY_BIRD.spots;
  if (sold >= EARLY_BIRD.spots) return STANDARD_PRICE;
  return { amountCents: EARLY_BIRD.amountCents, tier: "early", spotsLeft: EARLY_BIRD.spots - sold };
}
