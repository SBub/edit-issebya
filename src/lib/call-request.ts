// The checkout form: name, email, any number of optional social links and the
// terms checkbox, and the one validator the browser and the server action both
// run, so their messages are identical. `toCheckoutMetadata` turns a valid
// request into Stripe metadata: its keys are what the Stripe Dashboard (and
// the confirmation email) read, so never rename them.

export const CALL_REQUEST_FIELDS = ["name", "email", "socials", "terms"] as const;

export type CallRequestField = (typeof CALL_REQUEST_FIELDS)[number];

export interface CallRequest {
  name: string;
  email: string;
  // Absolute http(s) links; empty when the buyer has no social media yet.
  socials: string[];
  terms: true;
}

export type CallRequestErrors = Partial<Record<CallRequestField, string>>;

// Stripe caps a metadata value at 500 characters; the socials share one value.
export const MAX_FIELD_LENGTH = 500;
export const MAX_SOCIALS = 10;

export const CALL_REQUEST_LABELS = {
  name: "Name",
  email: "Email",
  socials: "Social media links",
  addSocial: "Add another link",
  removeSocial: "Remove link",
} as const;

export const CALL_REQUEST_HINTS = {
  socials: "Optional. Instagram, TikTok, LinkedIn, YouTube or a website.",
} as const;

export const CALL_REQUEST_MESSAGES = {
  required: "Please fill this in.",
  email: "Please enter a valid email address.",
  url: "Please check your links: each one should be a web address, like instagram.com/you.",
  tooLong: `Please keep this under ${MAX_FIELD_LENGTH} characters.`,
  terms: "Please agree to the terms and conditions to continue.",
} as const;

// Deliberately simple and non-backtracking.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "instagram.com/you" is what people type: a link without a scheme gets
// https://. Anything that is still not an http(s) URL with a dotted host is
// rejected.
export function normaliseLink(value: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  if (!URL.canParse(withScheme)) return null;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;
  return url.href;
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export type ParsedCallRequest =
  { ok: true; value: CallRequest } | { ok: false; errors: CallRequestErrors };

// Non-string values count as missing; every value is trimmed; empty social
// rows are dropped. `terms` must be exactly true (or the checkbox's "on").
export function parseCallRequest(input: Record<string, unknown>): ParsedCallRequest {
  const errors: CallRequestErrors = {};

  const name = text(input.name);
  if (name === "") errors.name = CALL_REQUEST_MESSAGES.required;
  else if (name.length > MAX_FIELD_LENGTH) errors.name = CALL_REQUEST_MESSAGES.tooLong;

  const email = text(input.email);
  if (email === "") errors.email = CALL_REQUEST_MESSAGES.required;
  else if (email.length > MAX_FIELD_LENGTH) errors.email = CALL_REQUEST_MESSAGES.tooLong;
  else if (!EMAIL_PATTERN.test(email)) errors.email = CALL_REQUEST_MESSAGES.email;

  const rawSocials = Array.isArray(input.socials) ? input.socials : [];
  const socials: string[] = [];
  for (const entry of rawSocials.slice(0, MAX_SOCIALS)) {
    const value = text(entry);
    if (value === "") continue;
    const link = normaliseLink(value);
    if (!link) {
      errors.socials = CALL_REQUEST_MESSAGES.url;
      break;
    }
    socials.push(link);
  }
  if (!errors.socials && socials.join("\n").length > MAX_FIELD_LENGTH) {
    errors.socials = CALL_REQUEST_MESSAGES.tooLong;
  }

  if (input.terms !== true && input.terms !== "on") errors.terms = CALL_REQUEST_MESSAGES.terms;

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, value: { name, email, socials, terms: true } };
}

// One string per key, as Stripe metadata requires: socials one per line, and
// the terms acceptance recorded alongside the payment.
export function toCheckoutMetadata(request: CallRequest): Record<string, string> {
  return {
    name: request.name,
    email: request.email,
    socials: request.socials.join("\n"),
    terms_accepted: "true",
  };
}
