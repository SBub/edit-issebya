import type { Instrumentation } from "next";

// Every uncaught server error of the studio (route handlers, server actions,
// server components) goes to PostHog error tracking, Node runtime only, and
// only when the two public PostHog variables are set (see
// app_docs/error-tracking.md). The module is imported dynamically so the Edge
// bundle never pulls in posthog-node. The hook never throws and awaits the
// flush, so a serverless function sends before it ends.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const tracking = await import("@/lib/error-tracking");
    const config = tracking.errorTrackingConfig();
    if (!config) return;
    const { supabaseConfig } = await import("@/lib/supabase-config");
    const userId = await tracking.requestUserId(request.headers.cookie, supabaseConfig());
    await tracking.captureRequestError(
      tracking.serverErrorCapture(config),
      error,
      request,
      context,
      userId,
    );
  } catch {
    // Error tracking never breaks the error page.
  }
};
