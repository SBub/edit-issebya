import { expect, test } from "@playwright/test";

// Smoke test: the placeholder home page renders, at desktop and phone widths.

test.describe("home page", () => {
  test("renders the heading", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "edit.issebya.com" })).toBeVisible();
  });

  test("has no horizontal scroll at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Compared with the root box, not window.innerWidth: `scrollbar-gutter:
    // stable` reserves 15px on Linux Chromium and nothing on macOS.
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
