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
    await expect(items).toHaveCount(LANDING.whatYouGet.items.length);
    for (const [i, item] of LANDING.whatYouGet.items.entries()) {
      await expect(items.nth(i)).toContainText(item.text);
    }
    await expect(items.getByRole("link", { name: "terms of service apply" })).toHaveAttribute(
      "href",
      "/terms",
    );
    for (const item of await items.all()) await expectInsideRoot(page, item);
    await expectInsideRoot(page, page.getByText(LANDING.closing, { exact: true }));
    await expectInsideRoot(page, page.getByText("990 EUR + VAT", { exact: true }));

    const card = page.getByRole("region", { name: "Edited reels" }).getByRole("article").first();
    for (const part of ["reel-media", "reel-label"]) {
      await expectInsideRoot(page, card.getByTestId(part));
    }

    await expectInsideRoot(page, ctaButton(page));

    await expectInsideRoot(page, page.getByText(LANDING.afterPurchase, { exact: true }));
    await expect(page.getByRole("link", { name: LANDING.questions.link })).toHaveAttribute(
      "href",
      LANDING.questions.href,
    );

    for (const item of LANDING.footer) {
      const link = page
        .getByRole("navigation", { name: "Legal" })
        .getByRole("link", { name: item.label });
      await expectInsideRoot(page, link);
      await expect(link).toHaveAttribute("href", item.href);
    }

    // The text column never runs into the offer section below it.
    const closing = await page.getByText(LANDING.closing, { exact: true }).boundingBox();
    const offer = await page.getByRole("region", { name: "Offer" }).boundingBox();
    expect(closing && offer && closing.y + closing.height <= offer.y + 0.5).toBe(true);
  });
}

test("the background stays white under a dark colour scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgb(255, 255, 255)");
});

for (const item of LANDING.footer) {
  test(`${item.label} has its own page with a way home`, async ({ page }) => {
    await page.goto(item.href);
    await expect(page.getByRole("heading", { level: 1, name: item.label })).toBeVisible();
    await page.getByRole("link", { name: "edit issebya, home" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
}
