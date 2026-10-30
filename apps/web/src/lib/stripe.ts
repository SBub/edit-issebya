import Stripe from "stripe";

// The API version the installed stripe SDK is typed against.
const API_VERSION = "2026-09-30.endive";

/**
 * A Stripe client for one server action call; never created at module load,
 * so a build or a page render without a key never touches Stripe.
 *
 * E2E_MOCK_STRIPE (see src/instrumentation.ts) intercepts Stripe's Node SDK
 * calls through an in-process MSW server for the Playwright suite. MSW's
 * FetchInterceptor reliably intercepts Stripe's alternate fetch-based HTTP
 * client, but the SDK's default NodeHttpClient (raw Node `https`) is not
 * reliably intercepted: that request hangs against a real network connection
 * instead of reaching the mock handler. Opting into the fetch-based client only
 * under this flag is what makes the E2E mock work; it has no effect on the
 * default client used by `yarn dev` and production, where the flag is unset.
 */
export function createStripeClient(key: string, mock: boolean): Stripe {
  return new Stripe(key, {
    apiVersion: API_VERSION,
    ...(mock ? { httpClient: Stripe.createFetchHttpClient() } : {}),
  });
}
