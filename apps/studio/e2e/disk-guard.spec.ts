import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// This spec's worker, so its status row is its own.
const WORKER_ID = `e2e-disk-guard-${crypto.randomUUID()}`;
const REASON = "waiting: 7.2 GB free on the worker's disk, needs 10 GB";
// The two scripts the composition loads from jsdelivr, served from the pinned
// local packages so the spec needs no network.
const CDN = [
  {
    url: "https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.222/dist/hyperframe.runtime.iife.js",
    path: fileURLToPath(
      new URL(
        "dist/hyperframe.runtime.iife.js",
        import.meta.resolve("@hyperframes/core/package.json"),
      ),
    ),
  },
  {
    url: "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
    path: fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
  },
];

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let page: Page;
const written = new Set<string>();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "disk-guard");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  for (const key of reel.keys) written.add(key);

  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
  for (const { url, path } of CDN) {
    await page.route(url, (route) =>
      route.fulfill({ path, contentType: "application/javascript" }),
    );
  }
});

test.afterAll(async () => {
  await page?.context().close();
  await admin.from("worker_status").delete().eq("worker_id", WORKER_ID);
  if (reel) {
    const { data } = await admin.from("exports").select("r2_key").eq("reel_id", reel.reelId);
    for (const row of (data ?? []) as { r2_key: string }[]) written.add(row.r2_key);
    // Leave nothing claimable for the next spec, even after a failure here.
    await admin.from("jobs").delete().eq("reel_id", reel.reelId).eq("status", "queued");
  }
  for (const key of written) await storage.delete(key);
  // The cascade removes the reel, its jobs, versions, exports and stored files.
  if (owner) await deleteTestUser(admin, owner.id);
});

async function renderJob() {
  const { data, error } = await admin
    .from("jobs")
    .select("id, status, attempts, lease_holder")
    .eq("reel_id", reel!.reelId)
    .eq("kind", "render")
    .single();
  if (error || !data) throw new Error(`render job not read: ${error?.message}`);
  return data as { id: string; status: string; attempts: number; lease_holder: string | null };
}

test("a queued job shows why the worker is not claiming it, live, until it claims", async ({
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  // The Export button is export.spec.ts's; here the job is queued directly.
  const queued = await admin.from("jobs").insert({
    reel_id: reel!.reelId,
    owner_id: owner.id,
    kind: "render",
    version_id: reel!.versionId,
  });
  expect(queued.error).toBeNull();
  const job = page.locator('[data-testid="job-item"][data-job-kind="render"]');
  await expect(job.getByTestId("job-status")).toHaveText("queued", { timeout: 10_000 });
  await expect(job.getByTestId("job-waiting")).toHaveCount(0);

  const waiting = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    WORKER_ID,
    E2E_MOCK_FREE_DISK_GB: "7.2",
    WORKER_MIN_FREE_DISK_GB: "10",
  });
  expect(waiting.code, waiting.output).toBe(0);
  expect(waiting.output).toContain(REASON);
  // Never claimed: no attempt, no lease.
  expect(await renderJob()).toMatchObject({ status: "queued", attempts: 0, lease_holder: null });
  await expect(job.getByTestId("job-waiting")).toHaveText(REASON, { timeout: 10_000 });

  const claimed = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    WORKER_ID,
    E2E_MOCK_FREE_DISK_GB: "11",
    WORKER_MIN_FREE_DISK_GB: "10",
  });
  expect(claimed.code, claimed.output).toBe(0);
  expect((await renderJob()).status).toBe("done");
  await expect(job.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  await expect(page.getByTestId("job-waiting")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
  const { data: status } = await admin
    .from("worker_status")
    .select("waiting_reason")
    .eq("worker_id", WORKER_ID)
    .single();
  expect(status).toEqual({ waiting_reason: null });
});
