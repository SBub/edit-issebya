import { expect, test, type Page } from "@playwright/test";
import { LANDING } from "../src/content/landing";
import { ctaButton, formDialog, oneScreen, rootBox, VIEWPORTS, waitForPageReady } from "./viewport";

// The owner's requirement: on one-screen viewports (wide screens, tablets in
// landscape) no vertical or horizontal page scroll, with or without a dialog
// open; on stacked viewports (phones, tablets in portrait) vertical scroll is
// expected but never sideways. Never by clipping html or body.

let vertical = true;

async function expectNoScroll(page: Page) {
  const box = await rootBox(page);
  if (vertical) {
    expect(box.scrollHeight, "vertical page scroll").toBeLessThanOrEqual(box.clientHeight);
  }
  expect(box.scrollWidth, "horizontal page scroll").toBeLessThanOrEqual(box.clientWidth);
}

async function expectNoClipping(page: Page) {
  const overflow = await page.evaluate(() =>
    [document.documentElement, document.body].flatMap((el) => {
      const style = getComputedStyle(el);
      return [style.overflowX, style.overflowY];
    }),
  );
  for (const value of overflow) expect(["hidden", "clip"]).not.toContain(value);
}

for (const viewport of VIEWPORTS) {
  const kind = oneScreen(viewport) ? "one screen" : "stacked";
  test.describe(`at ${viewport.width}x${viewport.height} (${kind})`, () => {
    test.use({ viewport });
    test.beforeEach(() => {
      vertical = oneScreen(viewport);
    });

    test("the page does not scroll", async ({ page }) => {
      await page.goto("/");
      await waitForPageReady(page);
      await expectNoScroll(page);
      await expectNoClipping(page);
    });

    test("the page does not scroll with the form dialog open", async ({ page }) => {
      await page.goto("/");
      await waitForPageReady(page);
      await ctaButton(page).click();
      await expect(formDialog(page)).toBeVisible();
      await expectNoScroll(page);
      await expectNoClipping(page);
    });

    test("the page does not scroll with the thank-you dialog open", async ({ page }) => {
      await page.goto("/?checkout=success&session_id=cs_test_x");
      await waitForPageReady(page);
      await expect(page.getByRole("dialog", { name: "Thank you" })).toBeVisible();
      await expect(page.getByText(LANDING.thankYou)).toBeVisible();
      await expectNoScroll(page);
      await expectNoClipping(page);
    });
  });
}

// Proves the measurement above can fail. waitForPageReady waits for hydration,
// so React never drops the injected element.
for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`negative check at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("a tall element makes the page scroll vertically", async ({ page }) => {
      await page.goto("/");
      await waitForPageReady(page);
      await page.evaluate(() => {
        const div = document.createElement("div");
        div.style.height = "200vh";
        document.querySelector("main")?.append(div);
      });
      const box = await rootBox(page);
      expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    });

    test("a wide element makes the page scroll horizontally", async ({ page }) => {
      await page.goto("/");
      await waitForPageReady(page);
      await page.evaluate(() => {
        const div = document.createElement("div");
        div.style.width = "200vw";
        div.style.height = "1px";
        document.querySelector("main")?.append(div);
      });
      const box = await rootBox(page);
      expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
    });
  });
}
