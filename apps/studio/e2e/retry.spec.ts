import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { unchangedAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type QueuedReel, seedQueuedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// Verification 4: a transient failure is retried once by the worker, then the
// job fails; the owner's Retry queues one new job naming it, which resumes at
// the failed step (every earlier step a fingerprint hit).
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
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
let reel: QueuedReel | null = null;
let scriptDir: string;
let script: string;
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
  owner = await createTestUser(admin, "retry");
  reel = await seedQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    skip: ["transcribe"],
  });
  for (const key of reel.keys) written.add(key);
  scriptDir = await mkdtemp(join(tmpdir(), "retry-"));
  script = await unchangedAnswerScript(scriptDir);

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
  if (reel) {
    // Leave nothing claimable for the next spec, even after a failure here.
    await admin
      .from("jobs")
      .delete()
      .eq("reel_id", reel.reelId)
      .in("status", ["queued", "running"]);
    for (const key of await storage.list(CACHE_PREFIX)) written.add(key);
  }
  for (const key of written) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

async function jobs() {
  const { data, error } = await admin
    .from("jobs")
    .select("id, status, retry_of_job_id")
    .eq("reel_id", reel!.reelId)
    .order("created_at");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return data as { id: string; status: string; retry_of_job_id: string | null }[];
}

async function stepsOf(jobId: string) {
  const { data, error } = await admin
    .from("steps")
    .select("name, status, cache_hit, summary")
    .eq("job_id", jobId)
    .order("started_at");
  if (error) throw new Error(`steps not read: ${error.message}`);
  return data as { name: string; status: string; cache_hit: boolean; summary: string | null }[];
}

async function reelStatus() {
  const { data } = await admin.from("reels").select("status").eq("id", reel!.reelId).single();
  return (data as { status: string }).status;
}

test("a transient failure is retried once, then Retry resumes at the failed step", async ({
  baseURL,
}) => {
  test.setTimeout(180_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });

  const failing = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: script,
    E2E_MOCK_STEP_RUN: "transcribe:fail-transient",
  });
  expect(failing.code, failing.output).toBe(1);
  expect(failing.output).toContain("step transcribe: transient failure, retrying once");
  const [first] = await jobs();
  expect(first).toMatchObject({ id: reel!.jobId, status: "failed" });
  const transcribeRows = (await stepsOf(reel!.jobId)).filter((s) => s.name === "transcribe");
  expect(transcribeRows.map((s) => s.status)).toEqual(["failed", "failed"]);
  expect(transcribeRows[0]!.summary).toMatch(/^transcribe failed, retried, /);
  expect(await reelStatus()).toBe("failed");

  const item = page.locator('[data-testid="job-item"]').first();
  await expect(item.getByTestId("job-status")).toHaveText("failed", { timeout: 10_000 });
  await item.getByTestId("job-retry").click();
  await expect.poll(async () => (await jobs()).length).toBe(2);
  const retry = (await jobs())[1]!;
  expect(retry).toMatchObject({ status: "queued", retry_of_job_id: reel!.jobId });
  await expect(item.getByTestId("job-retry")).toHaveCount(0, { timeout: 10_000 });
  await expect(item.getByTestId("job-retried")).toHaveText("retried");

  const resumed = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: script,
    E2E_MOCK_STEP_RUN: "transcribe:full",
  });
  expect(resumed.code, resumed.output).toBe(0);
  const steps = await stepsOf(retry.id);
  expect(steps.find((s) => s.name === "convert")).toMatchObject({
    status: "skipped",
    cache_hit: true,
  });
  expect(steps.find((s) => s.name === "transcribe")).toMatchObject({
    status: "done",
    cache_hit: false,
  });
  expect((await jobs())[1]!.status).toBe("done");
  expect(await reelStatus()).toBe("processed");
  await expect(page.getByTestId("reel-status")).toHaveText("processed", { timeout: 10_000 });
  await expect(page.getByTestId("job-retry")).toHaveCount(0);
});
