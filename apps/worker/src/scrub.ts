// Redaction shared by error tracking and the development error log
// (app_docs/error-tracking.md): nothing secret-shaped leaves the worker.

const REDACTED = "[redacted]";

// Each pattern has a single quantifier level (security/detect-unsafe-regex).
// The same rules as the studio's scrub (apps/studio/src/lib/error-tracking.ts).
const SCRUBBERS: [RegExp, string][] = [
  // A URL's query string: a signed URL's signature and credential live there.
  [/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, `$1?${REDACTED}`],
  // Secret-prefixed tokens: Supabase, Stripe, Resend, PostHog.
  [/\b(?:sb_secret_|sb_publishable_|sk_|rk_|whsec_|re_|phc_|phx_)\w+/g, REDACTED],
  [/\bBearer\s+[^\s"',]+/gi, `Bearer ${REDACTED}`],
  // A JWT: its header always starts with eyJ ({").
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED],
];

/** Redacts query strings, secret-prefixed tokens, Bearer tokens, JWTs and emails. */
export function scrub(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}
