import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let other: { id: string; email: string };
let newerId: string;
let otherReelId: string;
let processed: ProcessedReel | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "reels-owner");
  other = await createTestUser(admin, "reels-other");
  const now = Date.now();
  await insertReel(admin, {
    ownerId: owner.id,
    name: "older-take.mov",
    status: "uploaded",
    createdAt: new Date(now - 8 * DAY).toISOString(),
    sourceBytes: 65_221_017,
  });
  await insertReel(admin, {
    ownerId: owner.id,
    name: "third-take.mov",
    status: "uploaded",
    createdAt: new Date(now - 3 * DAY).toISOString(),
  });
  newerId = await insertReel(admin, {
    ownerId: owner.id,
    name: "newer-take.mov",
    status: "received",
    createdAt: new Date(now - 2 * HOUR).toISOString(),
  });
  otherReelId = await insertReel(admin, { ownerId: other.id, name: "someone-elses.mov" });
  // The newest reel: processed by the worker, so it has a thumbnail.
  processed = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
  });
});

test.afterAll(async () => {
  for (const key of processed?.keys ?? []) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
  if (other) await deleteTestUser(admin, other.id);
});

function tiles(page: Page) {
  return page.getByRole("list", { name: "Reels" }).getByRole("listitem");
}

test("the grid shows only the owner's reels, newest first, with age, size, status and a reel page", async ({
  page,
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));

  const items = tiles(page);
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText("short-speech.mp4");
  await expect(items.nth(0).getByTestId("reel-list-status")).toHaveText("processed");
  await expect(items.nth(1)).toContainText("newer-take.mov");
  await expect(items.nth(1).getByTestId("reel-list-status")).toHaveText("received");
  await expect(items.nth(1).getByTestId("tile-meta")).toHaveText("2h · Unknown size");
  await expect(items.nth(2)).toContainText("third-take.mov");
  await expect(items.nth(3)).toContainText("older-take.mov");
  await expect(items.nth(3).getByTestId("tile-meta")).toHaveText("1w · 62.2 MB");
  await expect(items.nth(3).getByTestId("reel-list-status")).toHaveText("uploaded");
  await expect(page.getByText("someone-elses.mov")).toHaveCount(0);

  // A reel without preview copies is a neutral tile; the processed one shows
  // its thumbnail, a JPEG the storage double serves.
  await expect(items.nth(1).locator('[data-thumbnail="none"]')).toHaveCount(1);
  await expect(items.nth(1).locator("img")).toHaveCount(0);
  const thumbnail = items.nth(0).locator("img");
  await expect(thumbnail).toHaveCount(1);
  await expect(items.nth(0).locator('[data-thumbnail="none"]')).toHaveCount(0);
  const src = await thumbnail.getAttribute("src");
  expect(src).toMatch(/\/cache\/preview_copies\/[0-9a-f]{64}\/thumbnail\.jpg/);
  const answer = await page.request.get(new URL(src!, page.url()).toString());
  expect(answer.status()).toBe(200);
  expect(answer.headers()["content-type"]).toBe("image/jpeg");
  const body = await answer.body();
  // JPEG's start-of-image marker.
  expect([body[0], body[1]]).toEqual([0xff, 0xd8]);
  await expect
    .poll(() => thumbnail.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBe(270);

  await items.nth(1).getByRole("link").click();
  await expect(page).toHaveURL(`/studio/reels/${newerId}`);
  await expect(page.getByRole("heading", { level: 1, name: "newer-take.mov" })).toBeVisible();
  await expect(page.getByTestId("reel-status")).toHaveText("received");

  await page.goto(`/studio/reels/${otherReelId}`);
  await expect(page.getByRole("heading", { name: "Reel not found" })).toBeVisible();
  await expect(page.getByText("someone-elses.mov")).toHaveCount(0);

  await page.goto("/studio/reels/not-a-uuid");
  await expect(page.getByRole("heading", { name: "Reel not found" })).toBeVisible();
});

test("on a phone the grid has three columns, and + opens and closes the upload", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await signInLink(admin, owner.email, baseURL!));

  const items = tiles(page);
  await expect(items).toHaveCount(4);
  const boxes = await Promise.all(
    [0, 1, 2, 3].map(async (n) => (await items.nth(n).boundingBox())!),
  );
  // The first three share a top edge, left to right; the fourth starts a row.
  expect(Math.abs(boxes[1]!.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes[2]!.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
  expect(boxes[2]!.x).toBeGreaterThan(boxes[1]!.x);
  expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 1);
  expect(Math.abs(boxes[3]!.x - boxes[0]!.x)).toBeLessThanOrEqual(1);

  await expect(page.getByLabel("Clip")).toBeHidden();
  await page.getByRole("button", { name: "Upload a reel" }).click();
  await expect(page.getByRole("dialog", { name: "Upload a reel" })).toBeVisible();
  await expect(page.getByLabel("Clip")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Clip")).toBeHidden();
  await page.getByRole("button", { name: "Upload a reel" }).click();
  await expect(page.getByLabel("Clip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Clip")).toBeHidden();
});

test("a signed-out visit to a reel page goes back to the login form", async ({ page }) => {
  await page.goto(`/studio/reels/${newerId}`);
  await expect(page).toHaveURL("/studio");
  await expect(page.getByLabel("Email")).toBeVisible();
});
