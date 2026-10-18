import { expect, type Locator, type Page } from "@playwright/test";

// Every viewport the page must fit without scrolling (the owner's list).
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

// Fonts loaded (Work Sans changes line breaks) and the first reel card shown.
export async function waitForPageReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(
    page.getByRole("region", { name: "Edited reels" }).getByRole("article").first(),
  ).toBeVisible();
}

// The element is visible and its bounding box lies inside the root box.
export async function expectInsideRoot(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "element has a bounding box").not.toBeNull();
  const root = await rootBox(page);
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(root.clientWidth + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(root.clientHeight + 0.5);
}

export const VALID_FORM = {
  name: "Ana Test",
  email: "ana@example.com",
  company_role: "Acme, founder",
  content_link: "https://example.com/ana",
  reels_purpose: "Explain the product in short clips",
  call_times: "weekdays 10:00 to 13:00 Lisbon time",
} as const;

export const FIELD_LABELS = {
  name: "Name",
  email: "Email",
  company_role: "Company and role",
  content_link: "Link to your content",
  reels_purpose: "What should the reels do for you?",
  call_times: "Good times for a call",
} as const;

export async function fillValidForm(
  dialog: Locator,
  values: Record<keyof typeof VALID_FORM, string> = VALID_FORM,
): Promise<void> {
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    await dialog.getByLabel(label, { exact: true }).fill(values[field as keyof typeof VALID_FORM]);
  }
}

export function formDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Book your discovery call" });
}

export function ctaButton(page: Page): Locator {
  return page.getByRole("button", { name: "Book your discovery call" });
}

export const MOCK_ROUTE = "/api/e2e-stripe-mock";
