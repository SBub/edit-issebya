// What Claude Code prints when it cannot answer now: a usage limit, or the
// tool signed out. Each pattern maps to the reason the owner reads; the
// captured fixtures are under testdata/ai-unavailable/ (app_docs/failures.md:
// confirm them against the worker machine's Claude Code when it changes).
const PATTERNS: { reason: string; matches: RegExp[] }[] = [
  {
    reason: "usage limit reached",
    matches: [/usage limit/i, /limit reached/i, /limit will reset/i],
  },
  {
    reason: "Claude Code is not logged in",
    matches: [
      /please run \/login/i,
      /not logged in/i,
      /invalid api key/i,
      /oauth token has expired/i,
    ],
  },
];

// The reason the AI is unavailable, or null when the text says nothing of the kind.
export function unavailableReason(text: string): string | null {
  for (const { reason, matches } of PATTERNS) {
    if (matches.some((pattern) => pattern.test(text))) return reason;
  }
  return null;
}
