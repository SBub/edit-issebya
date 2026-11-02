import { expect, test } from "@playwright/test";
import { waitForPageReady } from "./viewport";

// The owner's per-device opt-out: ?notrack stores edit_notrack = "1" and
// leaves a clean URL; ?track removes it (src/lib/notrack.ts).

const flag = () => window.localStorage.getItem("edit_notrack");

test("?notrack sets the flag and cleans the URL, ?track clears it", async ({ page }) => {
  await page.goto("/?notrack");
  await expect.poll(() => page.evaluate(flag)).toBe("1");
  await expect.poll(() => new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).pathname).toBe("/");
  // Still clean once the page has hydrated (the router never puts it back).
  await waitForPageReady(page);
  expect(await page.evaluate(() => window.location.search)).toBe("");

  // The flag survives a plain visit.
  await page.goto("/");
  expect(await page.evaluate(flag)).toBe("1");

  await page.goto("/terms?track");
  await expect.poll(() => page.evaluate(flag)).toBeNull();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).pathname).toBe("/terms");
});

test("other parameters survive the switch", async ({ page }) => {
  await page.goto("/?utm_source=ig&notrack");
  await expect.poll(() => new URL(page.url()).search).toBe("?utm_source=ig");
  await page.goto("/?track");
});
