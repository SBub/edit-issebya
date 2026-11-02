import { expect, test } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let other: { id: string; email: string };
let newerId: string;
let otherReelId: string;

test.beforeAll(async () => {
  owner = await createTestUser(admin, "reels-owner");
  other = await createTestUser(admin, "reels-other");
  await insertReel(admin, {
    ownerId: owner.id,
    name: "older-take.mov",
    status: "uploaded",
    createdAt: "2026-01-01T09:00:00Z",
  });
  newerId = await insertReel(admin, {
    ownerId: owner.id,
    name: "newer-take.mov",
    status: "received",
    createdAt: "2026-02-01T09:00:00Z",
  });
  otherReelId = await insertReel(admin, { ownerId: other.id, name: "someone-elses.mov" });
});

test.afterAll(async () => {
  if (owner) await deleteTestUser(admin, owner.id);
  if (other) await deleteTestUser(admin, other.id);
});

test("the list shows only the owner's reels, newest first, and a reel page", async ({
  page,
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));

  const items = page.getByRole("list", { name: "Reels" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("newer-take.mov");
  await expect(items.nth(0)).toContainText("received");
  await expect(items.nth(0)).toContainText("1 Feb 2026, 09:00 UTC");
  await expect(items.nth(1)).toContainText("older-take.mov");
  await expect(page.getByText("someone-elses.mov")).toHaveCount(0);

  await items.nth(0).getByRole("link").click();
  await expect(page).toHaveURL(`/studio/reels/${newerId}`);
  await expect(page.getByRole("heading", { level: 1, name: "newer-take.mov" })).toBeVisible();
  await expect(page.getByTestId("reel-status")).toHaveText("received");

  await page.goto(`/studio/reels/${otherReelId}`);
  await expect(page.getByRole("heading", { name: "Reel not found" })).toBeVisible();
  await expect(page.getByText("someone-elses.mov")).toHaveCount(0);

  await page.goto("/studio/reels/not-a-uuid");
  await expect(page.getByRole("heading", { name: "Reel not found" })).toBeVisible();
});

test("a signed-out visit to a reel page goes back to the login form", async ({ page }) => {
  await page.goto(`/studio/reels/${newerId}`);
  await expect(page).toHaveURL("/studio");
  await expect(page.getByLabel("Email")).toBeVisible();
});
