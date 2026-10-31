import type { EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

const TYPES: readonly string[] = ["email", "magiclink"];

// The magic link lands here with a token hash. The redirect is always a
// relative Location: behind the landing page's rewrite request.url carries the
// studio's internal host, and the browser must stay on the landing address.
export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");

  let ok = false;
  if (tokenHash && type && TYPES.includes(type)) {
    const supabase = await createSupabaseServerClient();
    if (supabase) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as EmailOtpType,
      });
      ok = !error;
    }
  }

  // cookies() set during verifyOtp are merged into this response by Next.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: ok ? "/studio" : "/studio?error=link" },
  });
}
