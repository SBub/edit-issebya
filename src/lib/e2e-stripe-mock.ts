// The E2E Stripe mock's shared state: the last Checkout request body the mock
// captured and the missing-key toggle. src/instrumentation.ts writes the
// capture, the /api/e2e-stripe-mock route reads and resets both, and the
// server action reads the toggle. They live on globalThis under Symbol.for
// keys, which are process-wide, so every bundle in the server process sees the
// same slots. Inert unless E2E_MOCK_STRIPE is exactly "true".

const LAST_CHECKOUT = Symbol.for("edit-issebya.e2eStripeLastCheckout");
const KEY_MISSING = Symbol.for("edit-issebya.e2eStripeKeyMissing");

interface MockSlots {
  [LAST_CHECKOUT]?: string | null;
  [KEY_MISSING]?: boolean;
}

const slots = globalThis as typeof globalThis & MockSlots;

export function isE2EMockStripe(): boolean {
  return process.env.E2E_MOCK_STRIPE === "true";
}

/** The raw form body of the last mocked Checkout request, or null. */
export function getLastCheckout(): string | null {
  return slots[LAST_CHECKOUT] ?? null;
}

export function setLastCheckout(body: string | null): void {
  slots[LAST_CHECKOUT] = body;
}

/** Whether the specs asked the action to behave as if no Stripe key were set. */
export function getKeyMissingToggle(): boolean {
  return slots[KEY_MISSING] ?? false;
}

export function setKeyMissingToggle(value: boolean): void {
  slots[KEY_MISSING] = value;
}
