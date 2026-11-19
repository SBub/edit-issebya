import { PostHog } from "posthog-node";

// The studio's feature flags (app_docs/feature-flags.md), evaluated on the
// server for the signed-in user, so a page renders nothing behind an off flag
// and a server action refuses it. Pure functions over an evaluator adapter,
// so tests pass a fake and never call PostHog.
//
// Checked against posthog-node 5.61.1 (dist/client.d.ts):
// `evaluateFlags(distinctId, { personProperties, flagKeys })` returns a
// snapshot whose `isEnabled(key, { sendFeatureFlagEvents })` reads one flag;
// `shutdown(timeoutMs)` ends the client.

/** The owner's editor (app_docs/owner-edits.md): on only for the owner for now. */
export const OWNER_EDIT_FLAG = "studio-owner-edit";

/** Who the flag is evaluated for: the Supabase user id (PostHog's distinct id) and the email. */
export interface FlagUser {
  id: string;
  email?: string | null;
}

export interface FlagsConfig {
  projectToken: string;
  host: string;
}

/** Evaluates one flag for one user: true only when PostHog says it is on. */
export type FlagEvaluator = (config: FlagsConfig, key: string, user: FlagUser) => Promise<boolean>;

interface FlagsEnv {
  serverToken: string | undefined;
  serverHost: string | undefined;
  publicToken: string | undefined;
  publicHost: string | undefined;
}

/**
 * The PostHog project the flags are read from: the server-only pair
 * `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` when both are set (so local
 * development can read flags without turning on browser analytics), else the
 * public pair the studio's analytics use. Null (every flag off) unless one
 * pair is complete.
 */
export function flagsConfig(
  env: FlagsEnv = {
    serverToken: process.env.POSTHOG_PROJECT_TOKEN,
    serverHost: process.env.POSTHOG_HOST,
    publicToken: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    publicHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  },
): FlagsConfig | null {
  for (const [token, host] of [
    [env.serverToken, env.serverHost],
    [env.publicToken, env.publicHost],
  ]) {
    const projectToken = token?.trim();
    const trimmedHost = host?.trim();
    if (projectToken && trimmedHost) return { projectToken, host: trimmedHost };
  }
  return null;
}

/**
 * Tests only: `E2E_MOCK_FLAGS`, a comma-separated list of flag keys, turns
 * those flags on for everyone without PostHog. Empty or unset: none.
 */
export function flagOverrides(value: string | undefined = process.env.E2E_MOCK_FLAGS): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  );
}

// How long the server waits for PostHog before it treats a flag as off.
const FLAG_TIMEOUT_MS = 1500;

/** The posthog-node evaluator: one short-lived client per evaluation, no exposure event. */
const posthogEvaluator: FlagEvaluator = async (config, key, user) => {
  const client = new PostHog(config.projectToken, {
    host: config.host,
    flushAt: 1,
    flushInterval: 0,
    featureFlagsRequestTimeoutMs: FLAG_TIMEOUT_MS,
  });
  try {
    const flags = await client.evaluateFlags(user.id, {
      flagKeys: [key],
      personProperties: user.email ? { email: user.email } : {},
    });
    return flags.isEnabled(key, { sendFeatureFlagEvents: false });
  } finally {
    await client.shutdown(FLAG_TIMEOUT_MS).catch(() => undefined);
  }
};

/**
 * Whether a flag is on for the user. On when the tests' override names it;
 * otherwise only when PostHog is configured, answers within the timeout and
 * says on. Unconfigured, unreachable, slow or failing: off. Never throws.
 */
export async function isFlagOn(
  key: string,
  user: FlagUser,
  {
    config = flagsConfig(),
    overrides = flagOverrides(),
    evaluate = posthogEvaluator,
  }: { config?: FlagsConfig | null; overrides?: Set<string>; evaluate?: FlagEvaluator } = {},
): Promise<boolean> {
  if (overrides.has(key)) return true;
  if (!config) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluate(config, key, user).then((on) => on === true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), FLAG_TIMEOUT_MS * 2);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
