// The discovery-call form: its six fields, in order, and the one validator the
// browser and the server action both run, so their messages are identical.
// The keys double as the Stripe metadata keys: never rename them.

export const CALL_REQUEST_FIELDS = [
  "name",
  "email",
  "company_role",
  "content_link",
  "reels_purpose",
  "call_times",
] as const;

export type CallRequestField = (typeof CALL_REQUEST_FIELDS)[number];
export type CallRequest = Record<CallRequestField, string>;
export type CallRequestErrors = Partial<Record<CallRequestField, string>>;

// Stripe caps a metadata value at 500 characters.
export const MAX_FIELD_LENGTH = 500;

export const CALL_REQUEST_LABELS: Record<CallRequestField, string> = {
  name: "Name",
  email: "Email",
  company_role: "Company and role",
  content_link: "Link to your content",
  reels_purpose: "What should the reels do for you?",
  call_times: "Good times for a call",
};

export const CALL_REQUEST_HINTS: Partial<Record<CallRequestField, string>> = {
  call_times: "e.g. weekdays 10:00 to 13:00 Lisbon time",
};

export const CALL_REQUEST_MESSAGES = {
  required: "Please fill this in.",
  email: "Please enter a valid email address.",
  url: "Please enter a link that starts with http:// or https://.",
  tooLong: `Please keep this under ${MAX_FIELD_LENGTH} characters.`,
} as const;

// Deliberately simple and non-backtracking.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

function fieldError(field: CallRequestField, value: string): string | undefined {
  if (value === "") return CALL_REQUEST_MESSAGES.required;
  if (value.length > MAX_FIELD_LENGTH) return CALL_REQUEST_MESSAGES.tooLong;
  if (field === "email" && !EMAIL_PATTERN.test(value)) return CALL_REQUEST_MESSAGES.email;
  if (field === "content_link" && !isHttpUrl(value)) return CALL_REQUEST_MESSAGES.url;
  return undefined;
}

export type ParsedCallRequest =
  { ok: true; value: CallRequest } | { ok: false; errors: CallRequestErrors };

// Non-string values count as missing; every value is trimmed.
export function parseCallRequest(input: Record<string, unknown>): ParsedCallRequest {
  const value = {} as CallRequest;
  const errors: CallRequestErrors = {};
  for (const field of CALL_REQUEST_FIELDS) {
    const raw = input[field];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    const error = fieldError(field, trimmed);
    if (error) errors[field] = error;
    value[field] = trimmed;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}
