import posthog from "posthog-js";
import { browserStorage, isTrackingDisabled } from "./notrack";

export interface CapturedEvent {
  event: string;
  properties?: Record<string, unknown>;
}

declare global {
  interface Window {
    // Set only by the Playwright specs (page.addInitScript) to observe events.
    __capturedEvents?: CapturedEvent[];
  }
}

/**
 * The test hook: under automation (navigator.webdriver, where PostHog never
 * initialises), and only when a spec has put an array on the window, the
 * event is also pushed there. In memory only, never written to storage.
 */
function recordForTests(event: string, properties?: Record<string, unknown>): void {
  if (typeof navigator === "undefined" || navigator.webdriver !== true) return;
  if (typeof window === "undefined" || !Array.isArray(window.__capturedEvents)) return;
  window.__capturedEvents.push(properties === undefined ? { event } : { event, properties });
}

/**
 * The one way components send an analytics event: a no-op on a device that
 * opted out with `?notrack` (src/lib/notrack.ts), otherwise posthog.capture,
 * itself a no-op wherever PostHog was not initialised.
 */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (isTrackingDisabled(browserStorage())) return;
  recordForTests(event, properties);
  posthog.capture(event, properties);
}
