import { expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
// One worker for both runs: the second run clears the reason the first wrote.
// The minimum is pinned so a filled apps/worker/.env.development cannot change the reason.
const workerId = `e2e-disk-${crypto.randomUUID()}`;
const worker = { WORKER_ID: workerId, WORKER_MIN_FREE_DISK_GB: "10" };
let owner: { id: string; email: string };
let sourceKey: string | null = null;

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "disk-guard");
});

test.afterAll(async () => {
  if (sourceKey) await storage.delete(sourceKey);
  await admin.from("worker_status").delete().eq("worker_id", workerId);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a queued job shows why the worker waits, live, until it has room", async ({
  page,
  baseURL,
}) => {
  const reelId = await insertReel(admin, {
    ownerId: owner.id,
    name: "disk.mp4",
    status: "uploaded",
  });
  sourceKey = `dev/reels/${reelId}/source/original.mp4`;
  const reel = await admin
    .from("reels")
    .update({ source_key: sourceKey, source_bytes: 4 })
    .eq("id", reelId);
  expect(reel.error).toBeNull();
  await storage.put(sourceKey, new Uint8Array([1, 2, 3, 4]));
  const job = await admin.from("jobs").insert({ reel_id: reelId, owner_id: owner.id });
  expect(job.error).toBeNull();

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible();
  await expect(page.getByTestId("job-status")).toHaveText("queued");
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const low = await runWorkerOnce({ ...worker, E2E_MOCK_FREE_DISK_GB: "7.2" });
  expect(low.code, low.output).toBe(0);
  expect(low.output).toContain("no job");
  await expect(page.getByTestId("job-waiting")).toHaveText(
    "waiting: 7.2 GB free on the worker's disk, needs 10 GB",
    { timeout: 10_000 },
  );
  const queued = await admin.from("jobs").select("status").eq("reel_id", reelId);
  expect(queued.data).toEqual([{ status: "queued" }]);

  const roomy = await runWorkerOnce({ ...worker, E2E_MOCK_FREE_DISK_GB: "50" });
  expect(roomy.code, roomy.output).toBe(0);
  await expect(page.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  await expect(page.getByTestId("job-waiting")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
});
