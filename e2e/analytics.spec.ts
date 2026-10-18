import { expect, test } from "@playwright/test";
import { ctaButton, fillValidForm, formDialog, MOCK_ROUTE, waitForPageReady } from "./viewport";

// No PostHog request and no PostHog storage under automation. The dev server
// is not production, so this alone cannot prove the navigator.webdriver gate;
// the falsifiable proof is the startAnalytics unit test in
// src/lib/analytics.test.ts.

function posthogHosts(): string[] {
  const hosts = ["posthog.com"];
  const configured = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (configured && URL.canParse(configured)) hosts.push(new URL(configured).host);
  return hosts;
}

test("nothing reaches PostHog through load, slider, form and checkout", async ({
  page,
  request,
}) => {
  const urls: string[] = [];
  page.on("request", (req) => urls.push(req.url()));

  expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await waitForPageReady(page);
  await page.getByRole("button", { name: "Next reel" }).click();
  await ctaButton(page).click();
  await fillValidForm(formDialog(page));
  await formDialog(page).getByRole("button", { name: "Continue to payment" }).click();
  await page.waitForURL(/checkout=success/);
  await expect(page.getByRole("dialog", { name: "Thank you" })).toBeVisible();

  const hosts = posthogHosts();
  for (const url of urls) {
    const host = new URL(url).host;
    for (const posthog of hosts) expect(host, url).not.toContain(posthog);
  }
  const keys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(keys.filter((key) => key.startsWith("ph_"))).toEqual([]);
});
