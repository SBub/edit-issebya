import posthog from "posthog-js";
import { STUDIO_SUPER_PROPERTIES } from "./analytics";
import type { StudioEvent } from "./studio-events";

// The event names live in ./studio-events (dependency-free); never renamed.

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
 * event is also pushed there with the super property PostHog would add. In
 * memory only, never written to storage.
 */
function recordForTests(
  event: StudioEvent | "$exception",
  properties: Record<string, unknown>,
): void {
  if (typeof navigator === "undefined" || navigator.webdriver !== true) return;
  if (typeof window === "undefined" || !Array.isArray(window.__capturedEvents)) return;
  window.__capturedEvents.push({
    event,
    properties: { ...STUDIO_SUPER_PROPERTIES, ...properties },
  });
}

/**
 * The one way studio components send an event; a no-op wherever PostHog was
 * not initialised. It reads no opt-out and no storage.
 */
export function capture(
  event: StudioEvent,
  properties: { reel_id: string } & Record<string, unknown>,
): void {
  recordForTests(event, properties);
  posthog.capture(event, properties);
}

/** Ties this page load's events to the signed-in user: the Supabase id, never the email. */
export function identify(userId: string): void {
  if (!posthog.__loaded) return;
  posthog.identify(userId);
}

/**
 * A handled browser failure, sent to PostHog error tracking with a stable
 * message (so every occurrence groups into one issue) and small properties:
 * never a file name, a key, a signed URL or an email. Under automation it is
 * only recorded by the test hook; PostHog never initialises there.
 */
export function captureException(
  message: string,
  properties: Record<string, string | number | boolean | null>,
): void {
  recordForTests("$exception", { $exception_message: message, ...properties });
  if (!posthog.__loaded) return;
  posthog.captureException(new Error(message), properties);
}

/**
 * A studio browser failure the owner cannot see (a dropped Realtime channel):
 * an exception in production, where PostHog is loaded, and a console warning
 * otherwise (development never sends it; console.error stays reserved for
 * server failures through reportFailure, server-failures.test.ts). Under automation the test hook
 * records it, as for captureException.
 */
export function reportBrowserFailure(
  message: string,
  properties: Record<string, string | number | boolean | null>,
): void {
  if (posthog.__loaded) {
    captureException(message, properties);
    return;
  }
  recordForTests("$exception", { $exception_message: message, ...properties });
  console.warn(message, properties);
}
