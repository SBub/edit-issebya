import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabaseConfig } from "./supabase-config";

// One client per request (server components, server actions, route handlers),
// never at module load, so `next build` needs no variables. Null when the
// studio is not configured. cookies() comes first so every caller renders per
// request, configured or not.
export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  const cookieStore = await cookies();
  const config = supabaseConfig();
  if (!config) return null;
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // A server component cannot set cookies; src/proxy.ts refreshes the
          // session on every page request instead.
        }
      },
    },
  });
}
