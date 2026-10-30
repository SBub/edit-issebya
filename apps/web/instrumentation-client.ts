import posthog from "posthog-js";
import { posthogInitOptions, startAnalytics } from "@/lib/analytics";
import { applyNotrackSwitch, browserStorage, isTrackingDisabled } from "@/lib/notrack";

// PostHog browser analytics, production only. All three variables are public
// and inlined at build time. NEXT_PUBLIC_VERCEL_ENV is set by Vercel itself
// ("production", "preview" or "development") and is absent in local builds,
// so local dev, ADW worktrees, e2e and preview deploys never initialise
// PostHog, even with a token in .env.local, and every posthog.capture call in
// the components is a no-op. Automated browsers (navigator.webdriver) never
// initialise it either, and `?internal=1` / `?internal=0` tags or untags this
// browser as internal (see app_docs/analytics.md). `?notrack` / `?track`
// switch this device's opt-out (src/lib/notrack.ts) in every environment,
// and the parameter is removed from the address bar.
const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;

const storage = browserStorage();
if (typeof window !== "undefined") {
  const cleaned = applyNotrackSwitch(storage, window.location.search);
  if (cleaned !== null) {
    const { pathname, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${cleaned}${hash}`);
  }
}

const browser =
  typeof navigator !== "undefined" && typeof window !== "undefined"
    ? {
        webdriver: navigator.webdriver,
        search: window.location.search,
        trackingDisabled: isTrackingDisabled(storage),
      }
    : undefined;

startAnalytics({ vercelEnv, projectToken, host: posthogHost }, browser, {
  init: (token, host) => {
    posthog.init(token, posthogInitOptions(host, process.env.NODE_ENV === "development"));
  },
  register: (properties) => {
    posthog.register(properties);
  },
  unregister: (property) => {
    posthog.unregister(property);
  },
});
