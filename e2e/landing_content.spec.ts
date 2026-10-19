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

    await expectInsideRoot(page, page.getByRole("heading", { level: 1, name: "edit issebya" }));
    await expectInsideRoot(page, page.getByLabel("edit issebya", { exact: true }));
    for (const paragraph of LANDING.description) {
      await expectInsideRoot(page, page.getByText(paragraph, { exact: true }));
    }
    const steps = page.getByRole("region", { name: "How it works" }).getByRole("listitem");
    await expect(steps).toHaveText([...LANDING.howItWorks.steps]);
    for (const step of await steps.all()) await expectInsideRoot(page, step);
    const items = page.getByRole("region", { name: "What you get" }).getByRole("listitem");
    await expect(items).toHaveText([...LANDING.whatYouGet.items]);
    for (const item of await items.all()) await expectInsideRoot(page, item);
    await expectInsideRoot(page, page.getByText(LANDING.closing, { exact: true }));
    await expectInsideRoot(page, page.getByText("990 EUR + VAT", { exact: true }));

    const card = page.getByRole("region", { name: "Edited reels" }).getByRole("article").first();
    for (const part of ["reel-media", "reel-label"]) {
      await expectInsideRoot(page, card.getByTestId(part));
    }

    await expectInsideRoot(page, ctaButton(page));

    // The text column never runs into the CTA below it.
    const price = await page.getByText("990 EUR + VAT", { exact: true }).boundingBox();
    const cta = await ctaButton(page).boundingBox();
    expect(price && cta && price.y + price.height <= cta.y + 0.5).toBe(true);
  });
}

test("the background stays white under a dark colour scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgb(255, 255, 255)");
});
