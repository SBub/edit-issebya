import posthog from "posthog-js";
import { STUDIO_SUPER_PROPERTIES } from "./analytics";

// Every studio event; names are never renamed once shipped.
export const STUDIO_EVENTS = [
  "studio_footage_uploaded",
  "studio_preview_opened",
  "studio_change_requested",
  "studio_export_requested",
  "studio_export_downloaded",
] as const;
export type StudioEvent = (typeof STUDIO_EVENTS)[number];

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
function recordForTests(event: StudioEvent, properties: Record<string, unknown>): void {
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
