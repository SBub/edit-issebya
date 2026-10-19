// The one offer the page sells. The amount is tax-exclusive: VAT, when Stripe
// Tax is on, is added at Checkout. The shown price and the charged price both
// come from this constant, so they cannot drift apart.
export const OFFER = {
  amountCents: 99000,
  currency: "eur",
  // The line item on Stripe Checkout: a short name and a one-line description,
  // so the Checkout page reads like a product, not a paragraph.
  productName: "8 reels, each under 1 minute",
  description: "Visual identity, recording guide and 30 days to send footage.",
  reelCount: 8,
  maxSeconds: 60,
} as const;

// "990 EUR + VAT", derived from the amount. No thousands separator, so the
// rendered text is exactly what the specs look for.
export function formatOfferPrice(offer: { amountCents: number; currency: string } = OFFER): string {
  return `${offer.amountCents / 100} ${offer.currency.toUpperCase()} + VAT`;
}
