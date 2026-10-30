import { unstable_cache } from "next/cache";
import { getKeyMissingToggle, isE2EMockStripe } from "./e2e-stripe-mock";
import { priceFor, STANDARD_PRICE, type OfferPrice } from "./offer";
import { countSold } from "./sold-count";
import { createStripeClient } from "./stripe";
import { stripeSecretKey } from "./stripe-key";

// How long the page may show a cached sold count. The server action never
// uses the cache: it counts again at checkout time.
const SOLD_COUNT_REVALIDATE_SECONDS = 60;

function key(): string | null {
  return stripeSecretKey(
    {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      E2E_MOCK_STRIPE: process.env.E2E_MOCK_STRIPE,
    },
    getKeyMissingToggle(),
  );
}

// Paid sessions of this offer, counted from Stripe (there is no database).
// Throws on any failure; the callers fall back to the full price.
async function fetchSoldCount(): Promise<number> {
  const secret = key();
  if (!secret) throw new Error("no Stripe secret key is configured");
  const stripe = createStripeClient(secret, isE2EMockStripe());
  return countSold(stripe.checkout.sessions.list({ status: "complete", limit: 100 }));
}

// unstable_cache, not "use cache": this app does not opt into Cache
// Components, and Next 16's guide for that setup names unstable_cache for
// non-fetch data. A thrown error is never cached.
const cachedSoldCount = unstable_cache(fetchSoldCount, ["offer-sold-count"], {
  revalidate: SOLD_COUNT_REVALIDATE_SECONDS,
});

/**
 * The price for the next buyer. `fresh` skips the cache (the server action at
 * checkout time); the E2E mock always skips it, so a spec's sold-count toggle
 * shows at once. Any failure (no key, Stripe unreachable) logs and returns the
 * full price: never show or charge a discount that cannot be checked.
 */
export async function currentOfferPrice({ fresh }: { fresh: boolean }): Promise<OfferPrice> {
  try {
    const sold = fresh || isE2EMockStripe() ? await fetchSoldCount() : await cachedSoldCount();
    return priceFor(sold);
  } catch (error) {
    console.error("currentOfferPrice: counting sold spots failed, using the full price", error);
    return STANDARD_PRICE;
  }
}
