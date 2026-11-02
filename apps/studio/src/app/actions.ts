"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { confirmUrl } from "@/lib/confirm-url";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type LoginState =
  | { status: "idle" }
  | { status: "invalid"; email: string }
  | { status: "sent" }
  | { status: "unavailable" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sends a magic link to an existing account. The answer is the same whether
// the address has an account, is unknown or hit the rate limit, so the form
// never reveals who has an account, and it never creates a user.
export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim() : "";
  if (!EMAIL.test(email)) return { status: "invalid", email };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "unavailable" };

  const requestHeaders = await headers();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: confirmUrl({
        siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
        forwardedProto: requestHeaders.get("x-forwarded-proto"),
        forwardedHost: requestHeaders.get("x-forwarded-host"),
        host: requestHeaders.get("host"),
      }),
    },
  });
  // Logged without the address.
  if (error)
    console.error("studio: magic link not sent:", error.code ?? error.status, error.message);
  return { status: "sent" };
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  // basePath-relative: lands on /studio.
  redirect("/");
}
