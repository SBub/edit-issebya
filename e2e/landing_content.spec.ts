import { expect, test } from "@playwright/test";
import { LANDING } from "../src/content/landing";
import { ctaButton, expectInsideRoot, VIEWPORTS, waitForPageReady } from "./viewport";

// Every required element is visible and fully inside the root box at every
// listed viewport: nothing is hidden or cut off to make the page fit.

for (const viewport of VIEWPORTS) {
  test(`all required content is visible at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await waitForPageReady(page);

    await expectInsideRoot(page, page.getByRole("heading", { level: 1, name: LANDING.heading }));
    await expectInsideRoot(page, page.getByText(LANDING.forWhom));

    const steps = page.getByRole("list", { name: "Process" }).getByRole("listitem");
    await expect(steps).toHaveCount(4);
    for (const step of await steps.all()) await expectInsideRoot(page, step);

    await expectInsideRoot(page, page.getByText(LANDING.offer));
    await expectInsideRoot(page, page.getByText("1200 EUR + VAT", { exact: true }));

    const card = page.getByRole("region", { name: "Edited reels" }).getByRole("article").first();
    for (const part of ["reel-media", "reel-label", "reel-title", "reel-caption"]) {
      await expectInsideRoot(page, card.getByTestId(part));
    }

    await expectInsideRoot(page, ctaButton(page));
  });
}

test("the background stays white under a dark colour scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgb(255, 255, 255)");
});
