import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./config.ts";

// The worker's client: the secret key (bypasses RLS), no session to persist.
// Created when the worker starts, never at module load.
export function workerSupabase(config: WorkerConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
