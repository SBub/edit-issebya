import { type SupabaseClient, createClient } from "@supabase/supabase-js";

// Test helpers only: nothing under src/ imports this folder (an ESLint rule
// enforces it), so the secret key never reaches the studio's bundle.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

// The shared local stack's database, default credentials of `supabase start`
// (supabase/config.toml, db port 54432). Local by construction.
export const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54432/postgres";

// Throws unless the URL's host is the local stack. No test ever reaches the
// hosted project.
export function assertLocalUrl(url: string | undefined): string {
  let hostname: string;
  try {
    hostname = new URL(url ?? "").hostname;
  } catch {
    throw new Error(`Refusing non-local Supabase URL: ${JSON.stringify(url ?? "")} does not parse`);
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing non-local Supabase URL ${url}: tests only reach 127.0.0.1 or localhost`,
    );
  }
  return url as string;
}

// process.env, or a literal in the unit test.
type Env = Record<string, string | undefined>;

// An admin client (secret key, bypasses RLS) for the local stack only.
export function localSupabaseAdmin(env: Env = process.env): SupabaseClient {
  const { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key } = env;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SECRET_KEY are required: fill apps/worker/.env.development from `supabase status`",
    );
  }
  return createClient(assertLocalUrl(url), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// A publishable-key client (what a browser or the studio holds) for the local
// stack only, with no session yet.
export function localSupabaseClient(env: Env = process.env): SupabaseClient {
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = env;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required: fill apps/studio/.env.development from `supabase status`",
    );
  }
  return createClient(assertLocalUrl(url), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
