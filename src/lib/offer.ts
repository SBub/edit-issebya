// The one offer the page sells. The amount is tax-exclusive: VAT, when Stripe
// Tax is on, is added at Checkout. The shown price and the charged price both
// come from this constant, so they cannot drift apart.
export const OFFER = {
  amountCents: 99000,
  currency: "eur",
  productName: "8 reels under 1 minute",
  reelCount: 8,
  maxSeconds: 60,
} as const;

// "990 EUR + VAT", derived from the amount. No thousands separator, so the
// rendered text is exactly what the specs look for.
export function formatOfferPrice(offer: { amountCents: number; currency: string } = OFFER): string {
  return `${offer.amountCents / 100} ${offer.currency.toUpperCase()} + VAT`;
}
