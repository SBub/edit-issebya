// The E2E Resend mock's shared state: every email request the mock recorded
// and the configMissing toggle. src/instrumentation.ts records, the
// /api/e2e-resend-mock route reads and resets both, and the Stripe webhook
// reads the toggle. On globalThis under Symbol.for keys, like the Stripe
// mock's state. Inert unless E2E_MOCK_RESEND is exactly "true".

const SENT = Symbol.for("edit-issebya.e2eResendSent");
const CONFIG_MISSING = Symbol.for("edit-issebya.e2eResendConfigMissing");

export interface RecordedEmail {
  body: unknown;
  idempotencyKey: string | null;
}

interface MockSlots {
  [SENT]?: RecordedEmail[];
  [CONFIG_MISSING]?: boolean;
}

const slots = globalThis as typeof globalThis & MockSlots;

export function isE2EMockResend(): boolean {
  return process.env.E2E_MOCK_RESEND === "true";
}

export function recordEmail(email: RecordedEmail): void {
  slots[SENT] = [...(slots[SENT] ?? []), email];
}

export function getRecordedEmails(): RecordedEmail[] {
  return slots[SENT] ?? [];
}

export function clearRecordedEmails(): void {
  slots[SENT] = [];
}

/** Whether the specs asked the webhook to treat BOOKING_URL as missing. */
export function getConfigMissingToggle(): boolean {
  return slots[CONFIG_MISSING] ?? false;
}

export function setConfigMissingToggle(value: boolean): void {
  slots[CONFIG_MISSING] = value;
}
