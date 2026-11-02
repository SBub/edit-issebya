import { type Page, expect, test } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The offline line under a queued job: shown live once the newest heartbeat
// is older than eleven minutes, gone live when a fresh one arrives. No worker
// runs here; the spec writes its own worker's heartbeat.
const WORKER_ID = `e2e-worker-offline-${crypto.randomUUID()}`;
const OFFLINE_AFTER_MS = 11 * 60_000;

const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let reelId: string | null = null;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  const since = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const { data: alive, error } = await admin
    .from("worker_status")
    .select("worker_id")
    .gt("heartbeat_at", since);
  if (error) throw new Error(`worker status not read: ${error.message}`);
  if ((alive ?? []).length > 0) {
    throw new Error(
      `a worker beat in the last 11 minutes (a running dev worker hides the offline line): ${alive!.map((row: { worker_id: string }) => row.worker_id).join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "worker-offline");
  reelId = await insertReel(admin, { ownerId: owner.id, name: "offline.mp4", status: "uploaded" });
  // Never claimed: no worker runs in this spec. Deleted in afterAll.
  const job = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, kind: "process", status: "queued" });
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);

  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page?.context().close();
  await admin.from("worker_status").delete().eq("worker_id", WORKER_ID);
  if (reelId) await admin.from("jobs").delete().eq("reel_id", reelId);
  if (owner) await deleteTestUser(admin, owner.id);
});

async function beat(at: Date) {
  const { error } = await admin.from("worker_status").upsert(
    {
      worker_id: WORKER_ID,
      free_disk_bytes: 100 * 1024 ** 3,
      heartbeat_at: at.toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "worker_id" },
  );
  if (error) throw new Error(`heartbeat not written: ${error.message}`);
}

test("a queued job says since when the worker is offline, live", async ({ baseURL }) => {
  test.setTimeout(60_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
  const job = page.locator('[data-testid="job-item"][data-job-kind="process"]');
  await expect(job.getByTestId("job-status")).toHaveText("queued");
  await expect(job.getByTestId("job-offline")).toHaveCount(0);

  const lastBeat = new Date(Date.now() - 20 * 60_000);
  await beat(lastBeat);
  const offline = job.getByTestId("job-offline");
  await expect(offline).toHaveText(/^Worker offline since \d{2}:\d{2}$/, { timeout: 10_000 });
  const expected = await page.evaluate((iso) => {
    const at = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `Worker offline since ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }, lastBeat.toISOString());
  await expect(offline).toHaveText(expected);

  await beat(new Date());
  await expect(offline).toHaveCount(0, { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
});
