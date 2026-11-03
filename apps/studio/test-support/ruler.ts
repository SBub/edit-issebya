import type { Locator, Page } from "@playwright/test";

// The tracks timeline's ruler: the reel page's one scrubber.
export function ruler(page: Page): Locator {
  return page.getByTestId("tracks").getByRole("slider", { name: "Position" });
}

// The page x of `seconds` on the ruler and its vertical middle, from the
// ruler's own box (never the window) and its full-precision duration.
export async function rulerPoint(page: Page, seconds: number): Promise<{ x: number; y: number }> {
  return ruler(page).evaluate((el, t) => {
    const box = el.getBoundingClientRect();
    const duration = Number((el as HTMLElement).dataset.duration);
    return { x: box.left + (t / duration) * box.width, y: box.top + box.height / 2 };
  }, seconds);
}

// Seeks the way an owner does: a real pointer down and up on the ruler at the
// x of `seconds` (Chromium keeps fractional pointer coordinates, so the seek
// lands on `seconds` to well under a millisecond).
export async function seekOnRuler(page: Page, seconds: number): Promise<void> {
  const { x, y } = await rulerPoint(page, seconds);
  await page.mouse.click(x, y);
}
