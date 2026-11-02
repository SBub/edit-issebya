// The studio's PostHog start-up, kept out of instrumentation-client.ts so the
// gate is testable in node. It never imports posthog-js: the client is passed
// in as an adapter (see app_docs/measurement.md).

// Sent with every studio event, so the studio's events never mix with the
// landing page's in the same project. Never rename it.
export const STUDIO_SUPER_PROPERTIES = { app: "studio" } as const;

/** The two public variables instrumentation-client.ts reads literally. */
export interface StudioAnalyticsEnv {
  projectToken: string | undefined;
  host: string | undefined;
}

/** What the browser tells us; undefined when there is no navigator. */
export interface StudioAnalyticsBrowser {
  webdriver: boolean | undefined;
}

/**
 * The posthog.init options. `persistence: "memory"` (posthog-js 1.438.12,
 * @posthog/types PostHogConfig): the distinct id lives in memory only, so no
 * cookie or storage is written, and `identify` with the Supabase user id still
 * carries a known user. Never `cookieless_mode`: it cannot carry an identified
 * user. Never opt_in_capturing / opt_out_capturing: they write consent to
 * storage.
 */
export function studioPosthogOptions(host: string, debug: boolean) {
  return {
    api_host: host,
    defaults: "2026-01-30",
    persistence: "memory",
    disable_session_recording: true,
    capture_exceptions: true,
    debug,
  } as const;
}

/** The two PostHog calls start-up needs; an adapter over posthog satisfies it. */
export interface StudioAnalyticsClient {
  init(projectToken: string, host: string): void;
  register(properties: typeof STUDIO_SUPER_PROPERTIES): void;
}

/**
 * Initialises PostHog when both variables are set (they are empty in
 * development and CI) in a browser that is not automated, then registers
 * `app: "studio"`. Unlike the landing page it reads no `?notrack` opt-out: the
 * studio's only users are signed in, and its owner, who has the opt-out set,
 * is the user it must count. Returns whether PostHog was initialised.
 */
export function startStudioAnalytics(
  env: StudioAnalyticsEnv,
  browser: StudioAnalyticsBrowser | undefined,
  client: StudioAnalyticsClient,
): boolean {
  if (!env.projectToken || !env.host || browser === undefined || browser.webdriver === true) {
    return false;
  }
  client.init(env.projectToken, env.host);
  client.register(STUDIO_SUPER_PROPERTIES);
  return true;
}
