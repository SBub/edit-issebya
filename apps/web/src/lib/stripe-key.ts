// The key the server action gives the Stripe client, or null when payment is
// unavailable. Pure: the caller passes the environment and the toggle.

// Never a real key: the E2E mock intercepts every Stripe call it is used for.
export const E2E_MOCK_STRIPE_KEY = "sk_test_e2e_mock";

interface StripeKeyEnv {
  STRIPE_SECRET_KEY?: string;
  E2E_MOCK_STRIPE?: string;
}

// Under E2E_MOCK_STRIPE === "true" the missing-key toggle wins, and the mock
// key stands in when no real one is set. Without the flag both are ignored.
export function stripeSecretKey(env: StripeKeyEnv, keyMissingToggle: boolean): string | null {
  const mock = env.E2E_MOCK_STRIPE === "true";
  if (mock && keyMissingToggle) return null;
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (key) return key;
  return mock ? E2E_MOCK_STRIPE_KEY : null;
}
