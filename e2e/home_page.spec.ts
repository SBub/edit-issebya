import { expect, test } from "@playwright/test";
import { LANDING } from "../src/content/landing";

// Smoke test: the landing page renders.

test("home page renders the heading", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: LANDING.heading })).toBeVisible();
});
