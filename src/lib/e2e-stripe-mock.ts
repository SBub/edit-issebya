// The E2E Stripe mock's shared state: the last Checkout request body the mock
// captured, the missing-key toggle and the sessions the mock created. src/instrumentation.ts writes the
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

// The Checkout Sessions the mock created, by id, so the webhook's retrieve and
// update calls have something to read and write. Only the fields the webhook
// reads.
const SESSIONS = Symbol.for("edit-issebya.e2eStripeSessions");

export interface MockSession {
  id: string;
  object: "checkout.session";
  url: string;
  metadata: Record<string, string>;
  customer_email: string | null;
  customer_details: { email: string | null };
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
}

const sessionSlots = globalThis as typeof globalThis & {
  [SESSIONS]?: Map<string, MockSession>;
};

function sessionMap(): Map<string, MockSession> {
  sessionSlots[SESSIONS] ??= new Map();
  return sessionSlots[SESSIONS];
}

// `metadata[key]=value` pairs of a form-encoded Stripe body, as a plain object.
export function formMetadata(params: URLSearchParams): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of params) {
    const match = /^metadata\[(.+)\]$/.exec(key);
    if (match?.[1]) metadata[match[1]] = value;
  }
  return metadata;
}

/** Stores the session the create handler answered with, built from its form body. */
export function storeSession(id: string, url: string, params: URLSearchParams): MockSession {
  const email = params.get("customer_email");
  const unitAmount = Number(params.get("line_items[0][price_data][unit_amount]") ?? Number.NaN);
  const quantity = Number(params.get("line_items[0][quantity]") ?? 1);
  const session: MockSession = {
    id,
    object: "checkout.session",
    url,
    metadata: formMetadata(params),
    customer_email: email,
    customer_details: { email },
    payment_status: "paid",
    amount_total: Number.isFinite(unitAmount) ? unitAmount * quantity : null,
    currency: params.get("line_items[0][price_data][currency]"),
  };
  sessionMap().set(id, session);
  return session;
}

export function getSession(id: string): MockSession | null {
  return sessionMap().get(id) ?? null;
}

export function listSessions(): MockSession[] {
  return [...sessionMap().values()];
}

/** Merges metadata into a stored session, as Stripe's update does. */
export function updateSessionMetadata(
  id: string,
  metadata: Record<string, string>,
): MockSession | null {
  const session = getSession(id);
  if (!session) return null;
  session.metadata = { ...session.metadata, ...metadata };
  return session;
}

export function setSessionPaymentStatus(id: string, paymentStatus: string): MockSession | null {
  const session = getSession(id);
  if (!session) return null;
  session.payment_status = paymentStatus;
  return session;
}

export function clearSessions(): void {
  sessionMap().clear();
}
