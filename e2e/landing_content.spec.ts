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
    await expectInsideRoot(page, page.getByLabel("edit issebya", { exact: true }));
    // Every sentence of the description, on its own line and without a full stop.
    for (const sentence of LANDING.description.flat()) {
      await expectInsideRoot(page, page.getByText(sentence, { exact: true }));
    }

    await expectInsideRoot(page, page.getByText(LANDING.offer));
    await expectInsideRoot(page, page.getByText("990 EUR + VAT", { exact: true }));
    await expectInsideRoot(page, page.getByText(LANDING.offerNote));

    const card = page.getByRole("region", { name: "Edited reels" }).getByRole("article").first();
    for (const part of ["reel-media", "reel-label"]) {
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
