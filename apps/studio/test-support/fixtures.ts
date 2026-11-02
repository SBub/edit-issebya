import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReelStatus } from "../src/lib/reels.ts";
import { localSupabaseClient } from "./local-supabase.ts";

// Every test address is on the reserved .test domain: no mail ever leaves.
export async function createTestUser(admin: SupabaseClient, label: string) {
  const email = `studio-${label}-${crypto.randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`test user not created: ${error?.message}`);
  return { id: data.user.id, email };
}

// on delete cascade removes the user's reels too.
export async function deleteTestUser(admin: SupabaseClient, id: string) {
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) throw new Error(`test user not deleted: ${error.message}`);
}

interface ReelInput {
  ownerId: string;
  name?: string | null;
  status?: ReelStatus;
  createdAt?: string;
}

// The admin bypasses RLS; createdAt fixes the list order deterministically.
export async function insertReel(admin: SupabaseClient, input: ReelInput): Promise<string> {
  const { data, error } = await admin
    .from("reels")
    .insert({
      owner_id: input.ownerId,
      source_name: input.name ?? null,
      status: input.status ?? "uploading",
      ...(input.createdAt ? { created_at: input.createdAt } : {}),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`reel not inserted: ${error?.message}`);
  return data.id as string;
}

async function hashedToken(admin: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) {
    throw new Error(`sign-in link not generated: ${error?.message}`);
  }
  return data.properties.hashed_token;
}

// A confirmation URL on the given address (the landing page's), signing in
// without any email being sent.
export async function signInLink(admin: SupabaseClient, email: string, baseUrl: string) {
  const token = await hashedToken(admin, email);
  return `${baseUrl.replace(/\/+$/, "")}/studio/auth/confirm?token_hash=${token}&type=email`;
}

// A publishable-key client holding a verified session for the user: what the
// browser holds after signing in.
export async function signedInClient(admin: SupabaseClient, email: string) {
  const client = localSupabaseClient();
  const { data, error } = await client.auth.verifyOtp({
    token_hash: await hashedToken(admin, email),
    type: "email",
  });
  if (error || !data.session) throw new Error(`session not verified: ${error?.message}`);
  return { client, session: data.session };
}
