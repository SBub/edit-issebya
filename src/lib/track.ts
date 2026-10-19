import posthog from "posthog-js";
import { browserStorage, isTrackingDisabled } from "./notrack";

/**
 * The one way components send an analytics event: a no-op on a device that
 * opted out with `?notrack` (src/lib/notrack.ts), otherwise posthog.capture,
 * itself a no-op wherever PostHog was not initialised.
 */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (isTrackingDisabled(browserStorage())) return;
  posthog.capture(event, properties);
}
