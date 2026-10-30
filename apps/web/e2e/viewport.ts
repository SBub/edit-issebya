import { expect, type Locator, type Page } from "@playwright/test";

// The owner's viewport list. `oneScreen` ones must fit without scrolling; the
// rest (phones, tablets in portrait) stack and scroll vertically.
export const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

// Mirrors the two-column breakpoint in globals.css: (min-width: 64rem), or
// (min-width: 48rem) in landscape.
export function oneScreen(viewport: { width: number; height: number }): boolean {
  return viewport.width >= 1024 || (viewport.width >= 768 && viewport.width > viewport.height);
}

export interface RootBox {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}

// Measured from the root box, never from window.innerWidth: `scrollbar-gutter:
// stable` reserves 15px on Linux Chromium (CI) and nothing on macOS.
export function rootBox(page: Page): Promise<RootBox> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  });
}

// React attaches its fiber to a DOM node (a `__reactFiber$` key) when it
// hydrates it, after matching the node's children against the server HTML, so
// a node added to <main> once the key is there is never dropped as a mismatch.
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    return main !== null && Object.keys(main).some((key) => key.startsWith("__reactFiber$"));
  });
}

// Fonts loaded (they change line breaks), the first reel card shown and React hydrated.
export async function waitForPageReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(
    page.getByRole("region", { name: "Edited reels" }).getByRole("article").first(),
  ).toBeVisible();
  await waitForHydration(page);
}

// The element is visible and its bounding box lies inside the root box once
// scrolled to (a no-op on one-screen viewports, which never scroll).
export async function expectInsideRoot(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, "element has a bounding box").not.toBeNull();
  const root = await rootBox(page);
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(root.clientWidth + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(root.clientHeight + 0.5);
}

export const VALID_FORM = {
  name: "Ana Test",
  email: "ana@example.com",
  socials: ["instagram.com/ana", "https://ana.example.com"],
} as const;

export const FIELD_LABELS = {
  name: "Name",
  email: "Email",
} as const;

// Name, email, two social rows (the second through the + button) and the
// terms checkbox.
export async function fillValidForm(dialog: Locator): Promise<void> {
  await dialog.getByLabel(FIELD_LABELS.name, { exact: true }).fill(VALID_FORM.name);
  await dialog.getByLabel(FIELD_LABELS.email, { exact: true }).fill(VALID_FORM.email);
  await dialog.getByLabel("Social media links 1", { exact: true }).fill(VALID_FORM.socials[0]);
  await dialog.getByRole("button", { name: "Add another link" }).click();
  await dialog.getByLabel("Social media links 2", { exact: true }).fill(VALID_FORM.socials[1]);
  await termsCheckbox(dialog).check();
}

export function termsCheckbox(dialog: Locator): Locator {
  return dialog.getByRole("checkbox", { name: /^I agree to the terms and conditions/ });
}

export function newsletterCheckbox(dialog: Locator): Locator {
  return dialog.getByRole("checkbox", { name: /^Send me occasional emails/ });
}

export function formDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Start your 30 days" });
}

export function ctaButton(page: Page): Locator {
  return page.getByRole("button", { name: "Start your 30 days" });
}

export const MOCK_ROUTE = "/api/e2e-stripe-mock";
