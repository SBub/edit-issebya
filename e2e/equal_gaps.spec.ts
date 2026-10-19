import { expect, test, type Locator, type Page } from "@playwright/test";
import { LANDING } from "../src/content/landing";
import { waitForPageReady } from "./viewport";

// The text column reads as one rhythm: the vertical gap between every pair of
// consecutive blocks is the same, within 1px. Desktop: quote, introduction,
// "How we work together", "What you get", closing line, offer box. Phone: the
// same blocks with the reel slider between the introduction and "How we work
// together".

function textBlocks(page: Page): Locator[] {
  return [
    page.getByText(`“${LANDING.quote}”`, { exact: true }),
    page.getByText(LANDING.intro, { exact: true }),
    page.getByRole("region", { name: "How we work together" }),
    page.getByRole("region", { name: "What you get" }),
    page.getByText(LANDING.closing, { exact: true }),
    page.getByRole("region", { name: "Offer" }),
  ];
}

async function gaps(blocks: Locator[]): Promise<number[]> {
  const boxes: { y: number; height: number }[] = [];
  for (const block of blocks) {
    const box = await block.boundingBox();
    expect(box, "block has a box").not.toBeNull();
    boxes.push(box!);
  }
  return boxes.slice(1).map((box, i) => box.y - (boxes[i]!.y + boxes[i]!.height));
}

function expectEqual(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  expect(max - min, `gaps ${values.map((v) => v.toFixed(1)).join(", ")}`).toBeLessThanOrEqual(1);
  expect(min).toBeGreaterThan(0);
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`at ${size.width}x${size.height} the right column's gaps are equal`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await waitForPageReady(page);
    expectEqual(await gaps(textBlocks(page)));
  });
}

test("on a phone the gaps between consecutive blocks are equal, reels included", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForPageReady(page);
  const [quote, intro, ...rest] = textBlocks(page);
  const reels = page.locator(".reel-area");
  expectEqual(await gaps([quote!, intro!, reels, ...rest]));
});
