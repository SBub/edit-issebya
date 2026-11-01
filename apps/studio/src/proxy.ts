import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseConfig } from "@/lib/supabase-config";

// Refreshes the Supabase session cookie on every page request, the
// @supabase/ssr pattern. Passes through untouched when the studio is not
// configured. Pages still check the user themselves.
export async function proxy(request: NextRequest) {
  const config = supabaseConfig();
  if (!config) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });
  await supabase.auth.getClaims();
  return response;
}

// The storage mock route is left out: it needs no session, and proxy buffers
// a request body only up to its client max body size (10 MB by default, see
// the next.config proxy option), which a 10 MiB upload part would reach.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/e2e-storage-mock|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
