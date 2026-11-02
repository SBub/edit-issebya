import type { Page } from "@playwright/test";
import type { CapturedEvent } from "../src/lib/track";

// Studio events as `capture` (src/lib/track.ts) sends them. PostHog never
// initialises under Playwright, so a spec opts in to the in-memory test hook:
// an array on the window, set before any page script runs, whose pushes are
// also handed to the spec so events survive navigations. Nothing is stored on
// the device. A copy of apps/web/e2e/events.ts: apps never import each other.

/**
 * Call before page.goto. Returns the spec's log of every event captured from
 * then on, across page loads, oldest first; it fills as the page runs, so read
 * it through `expect.poll`.
 */
export async function recordEvents(page: Page): Promise<CapturedEvent[]> {
  const log: CapturedEvent[] = [];
  await page.exposeFunction("__reportCapturedEvent", (entry: CapturedEvent) => {
    log.push(entry);
  });
  await page.addInitScript(() => {
    const events: NonNullable<Window["__capturedEvents"]> = [];
    events.push = (...entries) => {
      const report = (window as unknown as { __reportCapturedEvent?: (entry: unknown) => void })
        .__reportCapturedEvent;
      for (const entry of entries) report?.(entry);
      return Array.prototype.push.apply(events, entries);
    };
    window.__capturedEvents = events;
  });
  return log;
}

/** The logged events with this name. */
export function eventsNamed(log: readonly CapturedEvent[], name: string): CapturedEvent[] {
  return log.filter((entry) => entry.event === name);
}
