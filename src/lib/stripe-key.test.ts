import { describe, expect, it } from "vitest";
import { E2E_MOCK_STRIPE_KEY, stripeSecretKey } from "./stripe-key";

const REAL = "sk_test_real_value";

describe("stripeSecretKey", () => {
  it("returns the configured key, trimmed", () => {
    expect(stripeSecretKey({ STRIPE_SECRET_KEY: ` ${REAL} ` }, false)).toBe(REAL);
  });

  it("is null without a key and without the flag", () => {
    expect(stripeSecretKey({}, false)).toBeNull();
    expect(stripeSecretKey({ STRIPE_SECRET_KEY: "  " }, false)).toBeNull();
  });

  it("falls back to the mock key only under the flag", () => {
    expect(stripeSecretKey({ E2E_MOCK_STRIPE: "true" }, false)).toBe(E2E_MOCK_STRIPE_KEY);
  });

  it("is null when the toggle is on under the flag, even with a real key", () => {
    expect(stripeSecretKey({ STRIPE_SECRET_KEY: REAL, E2E_MOCK_STRIPE: "true" }, true)).toBeNull();
  });

  it("ignores the toggle without the flag", () => {
    expect(stripeSecretKey({ STRIPE_SECRET_KEY: REAL }, true)).toBe(REAL);
  });

  it("treats any flag value but the exact string true as no flag", () => {
    expect(stripeSecretKey({ E2E_MOCK_STRIPE: "1" }, false)).toBeNull();
    expect(stripeSecretKey({ STRIPE_SECRET_KEY: REAL, E2E_MOCK_STRIPE: "1" }, true)).toBe(REAL);
  });
});
