import posthog from "posthog-js";
import { startStudioAnalytics, studioPosthogOptions } from "@/lib/analytics";

// The studio's PostHog start-up: same project as the landing page, every event
// tagged `app: "studio"`, the signed-in user identified by their Supabase id
// (src/components/StudioIdentify.tsx), memory-only persistence. Both public
// variables are inlined at build time and empty in development and CI, and
// automated browsers (navigator.webdriver) never initialise it. The landing
// page's `?notrack` opt-out is deliberately not read here: the owner sets it
// to keep their own visits out of the landing funnel, while in the studio they
// are the user being measured (see app_docs/measurement.md).
const browser = typeof navigator !== "undefined" ? { webdriver: navigator.webdriver } : undefined;

startStudioAnalytics(
  {
    projectToken: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  },
  browser,
  {
    init: (token, host) => {
      posthog.init(token, studioPosthogOptions(host, process.env.NODE_ENV === "development"));
    },
    register: (properties) => {
      posthog.register(properties);
    },
  },
);
