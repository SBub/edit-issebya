// PostHog start-up, kept out of instrumentation-client.ts so the whole gate is
// testable in node. It never imports posthog-js: the client is passed in as an
// adapter (see app_docs/analytics.md).

// The super property a tagged browser sends with every event; the PostHog
// test-account filter matches on this literal. Never rename or derive it.
const INTERNAL_PROPERTY = "internal";

/** What the `internal` query parameter asks for: tag, untag, or nothing. */
export type InternalTagAction = "tag" | "untag" | null;

/** `?internal=1` tags, `?internal=0` untags, anything else (or nothing) is null. */
export function internalTagAction(search: string): InternalTagAction {
  const value = new URLSearchParams(search).get(INTERNAL_PROPERTY);
  if (value === "1") return "tag";
  if (value === "0") return "untag";
  return null;
}

/** The three public variables instrumentation-client.ts reads literally. */
export interface AnalyticsEnv {
  vercelEnv: string | undefined;
  projectToken: string | undefined;
  host: string | undefined;
}

/** What the browser tells us; undefined when there is no navigator or window. */
export interface AnalyticsBrowser {
  webdriver: boolean | undefined;
  search: string;
}

/** The three PostHog calls start-up needs; an adapter over posthog satisfies it. */
export interface AnalyticsClient {
  init(projectToken: string, host: string): void;
  register(properties: { [INTERNAL_PROPERTY]: true }): void;
  unregister(property: string): void;
}

/**
 * Initialises PostHog on production, with both variables set, in a browser
 * that is not automated (`navigator.webdriver` is not true), then applies the
 * `?internal=` tag. Tagging only adds a super property the PostHog filter
 * hides; it never opts out. Returns whether PostHog was initialised.
 */
export function startAnalytics(
  env: AnalyticsEnv,
  browser: AnalyticsBrowser | undefined,
  client: AnalyticsClient,
): boolean {
  if (
    env.vercelEnv !== "production" ||
    !env.projectToken ||
    !env.host ||
    browser === undefined ||
    browser.webdriver === true
  ) {
    return false;
  }
  client.init(env.projectToken, env.host);
  const action = internalTagAction(browser.search);
  if (action === "tag") client.register({ [INTERNAL_PROPERTY]: true });
  if (action === "untag") client.unregister(INTERNAL_PROPERTY);
  return true;
}
