import { expect, test, type Locator } from "@playwright/test";
import { REELS } from "../src/content/reels";
import { waitForPageReady } from "./viewport";

// One card per view at phone width; previous/next buttons and arrow keys move
// the track; videos never autoplay and are always muted.

test.use({ viewport: { width: 375, height: 667 } });

// Whether the card lies fully inside the track's visible box.
async function inView(card: Locator, track: Locator): Promise<boolean> {
  const [c, t] = await Promise.all([card.boundingBox(), track.boundingBox()]);
  if (!c || !t) return false;
  return c.x >= t.x - 1 && c.x + c.width <= t.x + t.width + 1;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForPageReady(page);
});

test("previous, next and the arrow keys move between cards", async ({ page }) => {
  const slider = page.getByRole("region", { name: "Edited reels" });
  const track = slider.getByRole("list", { name: "Reels" });
  const cards = slider.getByRole("article");
  const previous = slider.getByRole("button", { name: "Previous reel" });
  const next = slider.getByRole("button", { name: "Next reel" });

  await expect(cards).toHaveCount(REELS.length);
  expect(await inView(cards.nth(0), track)).toBe(true);
  expect(await inView(cards.nth(1), track)).toBe(false);
  await expect(previous).toBeDisabled();

  await next.click();
  await expect.poll(() => inView(cards.nth(1), track)).toBe(true);
  await expect(previous).toBeEnabled();

  await track.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => inView(cards.nth(2), track)).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => inView(cards.nth(1), track)).toBe(true);

  for (let i = 1; i < REELS.length - 1; i++) {
    await next.click();
    await expect.poll(() => inView(cards.nth(i + 1), track)).toBe(true);
  }
  await expect(next).toBeDisabled();
  expect(await inView(cards.nth(REELS.length - 1), track)).toBe(true);
});

test("videos are muted, inline and paused, never autoplaying", async ({ page }) => {
  const videos = page.locator("video");
  await expect(videos).toHaveCount(REELS.filter((r) => r.videoSrc !== null).length);
  const states = await videos.evaluateAll((els) =>
    (els as HTMLVideoElement[]).map((v) => ({
      muted: v.muted,
      autoplay: v.autoplay,
      paused: v.paused,
      playsInline: v.playsInline,
    })),
  );
  for (const state of states) {
    expect(state).toEqual({ muted: true, autoplay: false, paused: true, playsInline: true });
  }
});

test("placeholder reels say they are coming soon", async ({ page }) => {
  const placeholders = REELS.filter((r) => r.videoSrc === null).length;
  await expect(page.getByText("Reel coming soon", { exact: true })).toHaveCount(placeholders);
});

test("clicking a reel toggles play", async ({ page }) => {
  const reel = REELS.find((r) => r.videoSrc !== null);
  test.skip(reel === undefined, "all reels are placeholders");
  if (!reel) return;
  const slider = page.getByRole("region", { name: "Edited reels" });
  const next = slider.getByRole("button", { name: "Next reel" });
  for (let i = 0; i < REELS.indexOf(reel); i++) await next.click();
  await slider.getByRole("button", { name: `Play ${reel.title}` }).click();
  // Located through the card, not the button: the button's name flips between
  // Play and Pause, so a locator built on it stops matching after a click.
  const video = slider.getByRole("article", { name: reel.title }).locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await slider.getByRole("button", { name: `Pause ${reel.title}` }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
