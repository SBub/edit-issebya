// The five UTM parameters kept with a Checkout Session's metadata. The page
// picks them from its searchParams and the server action picks them again from
// what the browser sends, so nothing else ever reaches Stripe.

export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

// Stripe caps a metadata value at 500 characters.
const MAX_UTM_LENGTH = 500;

// The first value of a repeated parameter, trimmed and capped; empty values
// and unknown keys are dropped.
export function pickUtm(params: Record<string, string | string[] | undefined>): Utm {
  const utm: Utm = {};
  for (const key of UTM_KEYS) {
    const raw = params[key];
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first !== "string") continue;
    const value = first.trim().slice(0, MAX_UTM_LENGTH);
    if (value !== "") utm[key] = value;
  }
  return utm;
}
