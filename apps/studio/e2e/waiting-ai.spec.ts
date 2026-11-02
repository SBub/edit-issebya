import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { USAGE_LIMIT_SCRIPT, unchangedAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type QueuedReel, seedQueuedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// Verification 5: when the AI cannot answer, the fixed steps finish, the job
// waits 15 minutes with its reason (shown live), the worker takes another
// reel's job meanwhile, and the waiting job finishes once its time has come.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const LINE = /^Waiting for the AI: usage limit reached\. Next try at \d{2}:\d{2}\.$/;
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
const reels: QueuedReel[] = [];
let scriptDir: string;
let unchanged: string;
let page: Page;
const written = new Set<string>();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "waiting-ai");
  scriptDir = await mkdtemp(join(tmpdir(), "waiting-ai-"));
  unchanged = await unchangedAnswerScript(scriptDir);
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
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  for (const reel of reels) {
    // Leave nothing claimable for the next spec, even after a failure here.
    await admin
      .from("jobs")
      .delete()
      .eq("reel_id", reel.reelId)
      .in("status", ["queued", "running", "waiting_ai"]);
    for (const key of reel.keys) written.add(key);
  }
  for (const key of await storage.list(CACHE_PREFIX)) written.add(key);
  for (const key of written) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

async function seed() {
  const reel = await seedQueuedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  reels.push(reel);
  return reel;
}

async function job(id: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("status, waiting_reason, not_before, started_at")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(`job not read: ${error?.message}`);
  return data as {
    status: string;
    waiting_reason: string | null;
    not_before: string | null;
    started_at: string;
  };
}

test("a job waits for the AI, another reel's job runs meanwhile, then it finishes", async ({
  baseURL,
}) => {
  test.setTimeout(180_000);
  const a = await seed();
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${a.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const limited = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: USAGE_LIMIT_SCRIPT,
  });
  expect(limited.code, limited.output).toBe(0);
  expect(limited.output).toContain("waiting for the AI: usage limit reached");
  const waiting = await job(a.jobId);
  expect(waiting).toMatchObject({ status: "waiting_ai", waiting_reason: "usage limit reached" });
  // Both stamps come from the database clock.
  const ahead = Date.parse(waiting.not_before!) - Date.parse(waiting.started_at);
  expect(ahead).toBeGreaterThanOrEqual(14 * 60_000);
  expect(ahead).toBeLessThanOrEqual(16 * 60_000);
  const { data: steps } = await admin
    .from("steps")
    .select("name, status")
    .eq("job_id", a.jobId)
    .order("started_at");
  const rows = steps as { name: string; status: string }[];
  // The fixed steps finished first; only the AI step waits.
  for (const step of rows.filter((s) => s.name !== "decide")) {
    expect(["done", "skipped"], step.name).toContain(step.status);
  }
  expect(rows.at(-1)).toEqual({ name: "decide", status: "waiting_ai" });
  const item = page.locator('[data-testid="job-item"][data-job-kind="process"]');
  await expect(item.getByTestId("job-status")).toHaveText("waiting_ai", { timeout: 10_000 });
  await expect(item.getByTestId("job-waiting-ai")).toHaveText(LINE);

  // Meanwhile the worker takes another reel's job.
  const b = await seed();
  const other = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_AI_SCRIPT: unchanged });
  expect(other.code, other.output).toBe(0);
  expect(other.output).toContain(`job ${b.jobId}: claimed`);
  expect((await job(b.jobId)).status).toBe("done");
  expect((await job(a.jobId)).status).toBe("waiting_ai");

  // Its time has come (one minute before it was claimed, on the database clock).
  const past = new Date(Date.parse(waiting.started_at) - 60_000).toISOString();
  const moved = await admin.from("jobs").update({ not_before: past }).eq("id", a.jobId);
  expect(moved.error).toBeNull();
  const finished = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: unchanged,
  });
  expect(finished.code, finished.output).toBe(0);
  expect(await job(a.jobId)).toMatchObject({
    status: "done",
    waiting_reason: null,
    not_before: null,
  });
  await expect(item.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  await expect(page.getByTestId("job-waiting-ai")).toHaveCount(0);
  await expect(page.getByTestId("reel-status")).toHaveText("processed");
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
});
