import { type Page, expect, test } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { jobsOf, reelStatus } from "../test-support/rows.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// Deleting a reel from the reels grid (app_docs/studio.md, "Reels"): the bin in
// every tile's bottom-right corner, visible without hover, opens a confirm
// dialog; Cancel changes nothing, Delete removes the reel (its queued job with
// it), the list updates without a reload, its keys are queued for the worker,
// and its page is then not found. No worker runs here.

const PREFIX = `e2e-del-${crypto.randomUUID().slice(0, 8)}/`;
const CONFIRM_TEXT = "Delete this reel? Its versions and files are removed and cannot be restored";
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let keepId: string;
let deleteId: string;
let sourceKey: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "delete-reel");
  const now = Date.now();
  keepId = await insertReel(admin, {
    ownerId: owner.id,
    name: "keep-me.mov",
    status: "uploaded",
    createdAt: new Date(now - 60_000).toISOString(),
  });
  deleteId = await insertReel(admin, {
    ownerId: owner.id,
    name: "delete-me.mov",
    status: "received",
    createdAt: new Date(now).toISOString(),
  });
  sourceKey = `${PREFIX}reels/${deleteId}/source/original.mov`;
  const reel = await admin.from("reels").update({ source_key: sourceKey }).eq("id", deleteId);
  if (reel.error) throw new Error(`source key not set: ${reel.error.message}`);
  const recorded = await admin.rpc("record_stored_file", {
    p_reel_id: deleteId,
    p_r2_key: sourceKey,
    p_step: "upload",
    p_kind: "source",
    p_bytes: 1000,
  });
  if (recorded.error) throw new Error(`stored file not recorded: ${recorded.error.message}`);
  // The cascade case: a queued job goes with its reel (no worker claims it).
  const job = await admin
    .from("jobs")
    .insert({ reel_id: deleteId, owner_id: owner.id, kind: "process", status: "queued" });
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);
});

test.afterAll(async () => {
  if (deleteId) await admin.from("jobs").delete().eq("reel_id", deleteId);
  for (const reelId of [keepId, deleteId]) {
    if (reelId) await admin.from("storage_deletions").delete().eq("reel_id", reelId);
  }
  if (owner) await deleteTestUser(admin, owner.id);
});

function tiles(page: Page) {
  return page.getByRole("list", { name: "Reels" }).getByRole("listitem");
}

async function signIn(page: Page, baseURL: string) {
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await expect(tiles(page)).toHaveCount(2);
  // Hydrated: before that a tap on the bin would do nothing.
  await expect(page.getByRole("button", { name: "Upload a reel" })).toHaveAttribute(
    "data-ready",
    "true",
  );
}

for (const size of SIZES) {
  test(`at ${size.width}x${size.height} the bin sits in every tile's corner without hover, and Cancel keeps the reel`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(size);
    await signIn(page, baseURL!);
    // Nothing hovered.
    await page.mouse.move(0, 0);

    for (const n of [0, 1]) {
      const tile = tiles(page).nth(n);
      const bin = tile.getByRole("button", { name: "Delete reel" });
      await expect(bin).toBeVisible();
      const binBox = (await bin.boundingBox())!;
      const tileBox = (await tile.boundingBox())!;
      // Inside the tile, at its bottom-right corner.
      expect(binBox.x).toBeGreaterThanOrEqual(tileBox.x);
      expect(binBox.y).toBeGreaterThanOrEqual(tileBox.y);
      expect(Math.abs(binBox.x + binBox.width - (tileBox.x + tileBox.width))).toBeLessThanOrEqual(
        4,
      );
      expect(Math.abs(binBox.y + binBox.height - (tileBox.y + tileBox.height))).toBeLessThanOrEqual(
        4,
      );
      if (size.width < 640) {
        expect(binBox.width).toBeGreaterThanOrEqual(44);
        expect(binBox.height).toBeGreaterThanOrEqual(44);
      }
    }

    const target = tiles(page).filter({ hasText: "delete-me.mov" });
    await target.getByRole("button", { name: "Delete reel" }).click();
    const dialog = page.getByRole("dialog", { name: "delete-me.mov" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(CONFIRM_TEXT, { exact: true })).toBeVisible();
    // The bin never opens the reel.
    await expect(page).toHaveURL("/studio");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(tiles(page)).toHaveCount(2);
    expect(await reelStatus(admin, deleteId)).toBe("received");

    // Escape closes it like Cancel.
    await target.getByRole("button", { name: "Delete reel" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(tiles(page)).toHaveCount(2);
    expect(await reelStatus(admin, deleteId)).toBe("received");
  });
}

test("Delete removes the reel and its job, queues its key, and its page is then not found", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(SIZES[0]!);
  await signIn(page, baseURL!);
  expect(await jobsOf(admin, deleteId)).toHaveLength(1);

  await tiles(page)
    .filter({ hasText: "delete-me.mov" })
    .getByRole("button", { name: "Delete reel" })
    .click();
  const dialog = page.getByRole("dialog", { name: "delete-me.mov" });
  await dialog.getByTestId("confirm-delete-reel").click();
  await expect(dialog).toBeHidden();

  // Without a reload.
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).nth(0)).toContainText("keep-me.mov");
  await expect(page.getByText("delete-me.mov")).toHaveCount(0);

  expect(await reelStatus(admin, deleteId)).toBeNull();
  expect(await jobsOf(admin, deleteId)).toEqual([]);
  expect(await reelStatus(admin, keepId)).toBe("uploaded");
  const queued = await admin.from("storage_deletions").select("r2_key").eq("reel_id", deleteId);
  expect(queued.error).toBeNull();
  expect(queued.data).toEqual([{ r2_key: sourceKey }]);

  await page.goto(`/studio/reels/${deleteId}`);
  await expect(page.getByRole("heading", { name: "Reel not found" })).toBeVisible();
});
