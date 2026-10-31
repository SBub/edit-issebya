import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./supabase-config";

// The browser's client (publishable key, the session from the cookie). Created
// inside the component that needs it, never at module load; null when the
// studio is not configured.
export function createSupabaseBrowserClient(): SupabaseClient | null {
  const config = supabaseConfig();
  if (!config) return null;
  return createBrowserClient(config.url, config.publishableKey);
}
