import { expect, test, type Locator, type Page } from "@playwright/test";
import { ctaButton, FIELD_LABELS, formDialog, termsCheckbox, waitForPageReady } from "./viewport";

// The checkout dialog must always show its form. On the live site Safari
// (iPhone and macOS) showed only the header bar: the form was `flex-1`
// (`flex: 1 1 0%`) in a dialog sized only by max-height, and Safari's WebKit
// sized the dialog from that 0% basis. Playwright's newer WebKit and Chromium
// size it from the content, so they never showed the bug; the flex-basis
// check below is what catches it everywhere. Runs in Chromium and WebKit
// (playwright.config.ts), at a phone scrolled to the offer box, at short wide
// desktops, and at short heights where the form must scroll inside the
// dialog.

const SIZES = [
  { width: 390, height: 844 },
  { width: 1440, height: 830 },
  { width: 1800, height: 830 },
  { width: 390, height: 480 },
  { width: 1440, height: 480 },
];

async function expectShownInViewport(page: Page, locator: Locator, name: string) {
  await expect(locator, name).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  if (!box) return;
  const root = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
  expect(box.height, `${name} height`).toBeGreaterThan(0);
  expect(box.y, `${name} top`).toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(root.height + 0.5);
  expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(root.width + 0.5);
}

for (const size of SIZES) {
  test(`at ${size.width}x${size.height} the dialog shows the whole form`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await waitForPageReady(page);
    // The owner opened it after scrolling down to the offer box.
    await ctaButton(page).scrollIntoViewIfNeeded();
    await ctaButton(page).click();
    const dialog = formDialog(page);
    await expect(dialog).toBeVisible();

    const form = dialog.locator("form");
    const formBox = await form.boundingBox();
    expect(formBox && formBox.height, "form height").toBeGreaterThan(100);
    // Never a 0% flex basis on the form or its scrolling body (the Safari
    // collapse); auto takes the content size in every engine.
    for (const element of [form, form.locator("> div").first()]) {
      expect(await element.evaluate((node) => getComputedStyle(node).flexBasis)).toBe("auto");
    }

    await expectShownInViewport(
      page,
      dialog.getByLabel(FIELD_LABELS.name, { exact: true }),
      "Name field",
    );
    await expectShownInViewport(page, termsCheckbox(dialog), "terms checkbox");
    await expectShownInViewport(
      page,
      dialog.getByRole("button", { name: "Continue to payment" }),
      "Continue button",
    );
  });
}
