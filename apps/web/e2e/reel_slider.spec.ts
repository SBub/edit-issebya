import { expect, test, type Locator } from "@playwright/test";
import { REELS } from "../src/content/reels";
import type { CapturedEvent } from "../src/lib/track";
import { eventsNamed, recordEvents } from "./events";
import { waitForPageReady } from "./viewport";

// One card per view at phone width with the next one peeking in; swiping and
// the arrow keys move the track; there are no buttons; videos never autoplay,
// play with sound when clicked, and only one plays at a time.

test.use({ viewport: { width: 375, height: 667 } });

// Whether the card lies fully inside the track's visible box.
async function inView(card: Locator, track: Locator): Promise<boolean> {
  const [c, t] = await Promise.all([card.boundingBox(), track.boundingBox()]);
  if (!c || !t) return false;
  return c.x >= t.x - 1 && c.x + c.width <= t.x + t.width + 1;
}

// Every analytics event of the current test (e2e/events.ts).
let log: CapturedEvent[] = [];

test.beforeEach(async ({ page }) => {
  log = await recordEvents(page);
  await page.goto("/");
  await waitForPageReady(page);
});

test("the arrow keys and a swipe move between cards, with no buttons", async ({ page }) => {
  const slider = page.getByRole("region", { name: "Edited reels" });
  const track = slider.getByRole("list", { name: "Reels" });
  const cards = slider.getByRole("article");

  await expect(cards).toHaveCount(REELS.length);
  await expect(slider.getByRole("button", { name: /reel$/ })).toHaveCount(0);
  expect(await inView(cards.nth(0), track)).toBe(true);
  expect(await inView(cards.nth(1), track)).toBe(false);
  // The next card peeks in, so a swipe is discoverable.
  const [second, box] = await Promise.all([cards.nth(1).boundingBox(), track.boundingBox()]);
  expect(second && box && second.x < box.x + box.width).toBe(true);

  await track.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => inView(cards.nth(1), track)).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => inView(cards.nth(0), track)).toBe(true);

  // A swipe is a horizontal scroll of the track; snapping lands on a card.
  await track.evaluate((el) => el.scrollBy({ left: el.clientWidth, behavior: "auto" }));
  await expect.poll(() => inView(cards.nth(1), track)).toBe(true);
});

test("videos are inline and paused with sound on, never autoplaying", async ({ page }) => {
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
    expect(state).toEqual({ muted: false, autoplay: false, paused: true, playsInline: true });
  }
});

test("placeholder reels say they are coming soon", async ({ page }) => {
  const placeholders = REELS.filter((r) => r.videoSrc === null).length;
  await expect(page.getByText("Reel coming soon", { exact: true })).toHaveCount(placeholders);
});

test("clicking a reel toggles play, and starting another pauses it", async ({ page }) => {
  const playable = REELS.filter((r) => r.videoSrc !== null);
  test.skip(playable.length < 2, "needs two real reels");
  const [first, second] = playable;
  if (!first || !second) return;
  await page.setViewportSize({ width: 1440, height: 900 });
  const slider = page.getByRole("region", { name: "Edited reels" });
  // Located through the card, not the button: the button's name flips between
  // Play and Pause, so a locator built on it stops matching after a click.
  const video = (reel: typeof first) =>
    slider.getByRole("article", { name: reel.title }).locator("video");
  const paused = (reel: typeof first) => video(reel).evaluate((v: HTMLVideoElement) => v.paused);

  await slider.getByRole("button", { name: `Play ${first.title}` }).click();
  await expect.poll(() => paused(first)).toBe(false);
  expect(await video(first).evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);

  await slider.getByRole("button", { name: `Play ${second.title}` }).click();
  await expect.poll(() => paused(second)).toBe(false);
  await expect.poll(() => paused(first)).toBe(true);

  await slider.getByRole("button", { name: `Pause ${second.title}` }).click();
  await expect.poll(() => paused(second)).toBe(true);
});

test("on a phone the first reel's video is centred in the slider", async ({ page }) => {
  // Against the slider's box, not the window: Linux Chromium (CI) draws a 15px
  // scrollbar on the scrolling phone layout, phones overlay theirs.
  const media = await page.getByTestId("reel-media").first().boundingBox();
  const slider = await page.getByRole("region", { name: "Edited reels" }).boundingBox();
  expect(media && slider).toBeTruthy();
  if (!media || !slider) return;
  const offset = media.x + media.width / 2 - (slider.x + slider.width / 2);
  expect(Math.abs(offset)).toBeLessThanOrEqual(2);
});

test("on a phone each reel has a full-screen button that plays it full screen", async ({
  page,
}) => {
  const reel = REELS.find((r) => r.videoSrc !== null);
  test.skip(reel === undefined, "all reels are placeholders");
  if (!reel) return;
  // Headless Chromium has no real full screen: record the call instead.
  await page.evaluate(() => {
    (window as unknown as { fullscreenCalls: number }).fullscreenCalls = 0;
    HTMLVideoElement.prototype.requestFullscreen = function () {
      (window as unknown as { fullscreenCalls: number }).fullscreenCalls += 1;
      return Promise.resolve();
    };
  });
  const button = page.getByRole("button", { name: `Full screen ${reel.title}` });
  await expect(button).toBeVisible();
  await button.click();
  expect(
    await page.evaluate(() => (window as unknown as { fullscreenCalls: number }).fullscreenCalls),
  ).toBe(1);
  const video = page.getByRole("article", { name: reel.title }).locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await expect
    .poll(() => eventsNamed(log, "reel_fullscreen"))
    .toEqual([
      {
        event: "reel_fullscreen",
        properties: { reel_id: reel.id, variant: REELS.indexOf(reel) + 1 },
      },
    ]);
});

test("wide screens show no full-screen button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("button", { name: /^Full screen / })).toHaveCount(0);
});

test("on a phone dots show which reel is in view and jump to another", async ({ page }) => {
  const slider = page.getByRole("region", { name: "Edited reels" });
  const track = slider.getByRole("list", { name: "Reels" });
  const cards = slider.getByRole("article");
  const dots = slider.getByRole("group", { name: "Choose a reel" }).getByRole("button");
  await expect(dots).toHaveCount(REELS.length);
  await expect(dots.nth(0)).toHaveAttribute("aria-current", "true");

  const last = REELS.length - 1;
  await dots.nth(last).click();
  await expect.poll(() => inView(cards.nth(last), track)).toBe(true);
  await expect(dots.nth(last)).toHaveAttribute("aria-current", "true");
  await expect(dots.nth(0)).not.toHaveAttribute("aria-current", "true");

  // A swipe moves the current dot too.
  await track.evaluate((el) => el.scrollTo({ left: 0, behavior: "auto" }));
  await expect(dots.nth(0)).toHaveAttribute("aria-current", "true");
});

test("wide screens, where every reel fits, show no dots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("group", { name: "Choose a reel" })).toHaveCount(0);
});

test("reel_played carries the reel's 1-based place in REELS as variant", async ({ page }) => {
  const playable = REELS.filter((r) => r.videoSrc !== null);
  test.skip(playable.length < 2, "needs two real reels");
  await page.setViewportSize({ width: 1440, height: 900 });
  const slider = page.getByRole("region", { name: "Edited reels" });
  for (const reel of playable.slice(0, 2)) {
    await slider.getByRole("button", { name: `Play ${reel.title}` }).click();
  }
  await expect
    .poll(() => eventsNamed(log, "reel_played"))
    .toEqual(
      playable.slice(0, 2).map((reel) => ({
        event: "reel_played",
        properties: { reel_id: reel.id, variant: REELS.indexOf(reel) + 1 },
      })),
    );
});

test("reel_progress sends 25, 50 and 100 once per play-through from the start", async ({
  page,
}) => {
  const reel = REELS.find((r) => r.videoSrc !== null);
  test.skip(reel === undefined, "all reels are placeholders");
  if (!reel) return;
  await page.setViewportSize({ width: 1440, height: 900 });
  const slider = page.getByRole("region", { name: "Edited reels" });
  const video = slider.getByRole("article", { name: reel.title }).locator("video");
  // A 40 second reel whose clock the spec moves: the real file plays, but
  // duration and currentTime are this element's own stand-ins, and each move
  // sends a timeupdate the way playback does.
  await video.evaluate((v: HTMLVideoElement) => {
    let time = 0;
    Object.defineProperty(v, "duration", { configurable: true, get: () => 40 });
    Object.defineProperty(v, "currentTime", {
      configurable: true,
      get: () => time,
      set: (value: number) => {
        time = value;
      },
    });
  });
  const moveTo = (seconds: number) =>
    video.evaluate((v: HTMLVideoElement, value) => {
      v.currentTime = value;
      v.dispatchEvent(new Event("timeupdate"));
    }, seconds);
  const percents = () =>
    eventsNamed(log, "reel_progress").map((entry) => entry.properties?.percent);
  const variant = REELS.indexOf(reel) + 1;

  await slider.getByRole("button", { name: `Play ${reel.title}` }).click();
  await expect.poll(() => eventsNamed(log, "reel_played")).toHaveLength(1);
  await moveTo(5);
  await expect.poll(percents).toEqual([]);
  await moveTo(11);
  await moveTo(21);
  // The loop wraps from near the end back to the start: the end.
  await moveTo(39);
  await moveTo(0.2);
  await moveTo(15);
  await expect.poll(percents).toEqual([25, 50, 100]);
  expect(eventsNamed(log, "reel_progress")[0]).toEqual({
    event: "reel_progress",
    properties: { reel_id: reel.id, variant, percent: 25 },
  });

  // Paused, then played again from the start: a new play-through.
  await slider.getByRole("button", { name: `Pause ${reel.title}` }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await moveTo(0);
  await slider.getByRole("button", { name: `Play ${reel.title}` }).click();
  // The play event is queued: wait for the play to land (reel_played follows it).
  await expect.poll(() => eventsNamed(log, "reel_played")).toHaveLength(2);
  await moveTo(11);
  await expect.poll(percents).toEqual([25, 50, 100, 25]);
});
