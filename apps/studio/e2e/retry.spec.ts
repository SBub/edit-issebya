import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { expect, test } from "@playwright/test";
import { SHORT_SPEECH_ANSWER } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { insertQueuedReel, seedPipelineCache } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// The pipeline step double (no real tools) and the committed decide answer.
const STEPS = {
  R2_KEY_PREFIX: CACHE_PREFIX,
  E2E_MOCK_STEPS: "true",
  E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
};

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };

interface StepRecord {
  job_id: string;
  name: string;
  status: string;
  cache_hit: boolean;
  summary: string | null;
}

async function stepsOf(reelId: string): Promise<StepRecord[]> {
  const { data, error } = await admin
    .from("steps")
    .select("job_id, name, status, cache_hit, summary")
    .eq("reel_id", reelId)
    .order("started_at");
  expect(error).toBeNull();
  return (data ?? []) as StepRecord[];
}

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "retry");
});

test.afterAll(async () => {
  for (const key of await storage.list(CACHE_PREFIX)) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a step killed twice fails the job; Retry resumes at that step and finishes, live", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { reelId, jobId } = await insertQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
  });
  await seedPipelineCache(storage, CACHE_PREFIX, { except: ["transcribe"] });

  // The transcribe double kills itself with SIGKILL: transient, so it runs
  // once more, then the job fails.
  const first = await runWorkerOnce({ ...STEPS, E2E_MOCK_STEP_FAULT: "transcribe:signal" });
  expect(first.code, first.output).toBe(1);
  const { data: failed } = await admin.from("jobs").select("status").eq("id", jobId).single();
  expect(failed).toEqual({ status: "failed" });
  const transcribes = (await stepsOf(reelId)).filter((step) => step.name === "transcribe");
  expect(transcribes.map((step) => step.status)).toEqual(["failed", "failed"]);
  expect(transcribes[0]!.summary).toMatch(/^transcribe failed, retrying once/);
  expect(transcribes[1]!.summary).not.toMatch(/retrying once/);

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
  await expect(page.getByTestId("reel-status")).toHaveText("failed");
  await expect(page.getByTestId("change-blocked-reason")).toHaveText(
    "Processing failed; press Retry on the failed job first.",
  );

  await page.getByTestId("job-retry").click();
  const items = page.getByTestId("job-item");
  await expect(items).toHaveCount(2, { timeout: 10_000 });
  await expect(items.nth(1).getByTestId("job-retry-of")).toHaveText("retry");
  await expect(items.nth(1).getByTestId("job-status")).toHaveText("queued");
  // The failed job is retried now: no second Retry.
  await expect(page.getByTestId("job-retry")).toHaveCount(0);
  const { data: retries } = await admin
    .from("jobs")
    .select("id, kind, status")
    .eq("retry_of_job_id", jobId);
  expect(retries).toEqual([{ id: expect.any(String), kind: "process", status: "queued" }]);
  const retryId = retries![0]!.id as string;

  const second = await runWorkerOnce(STEPS);
  expect(second.code, second.output).toBe(0);

  await expect(items.nth(1).getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  await expect(page.getByTestId("reel-status")).toHaveText("processed", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );

  const retried = (await stepsOf(reelId)).filter((step) => step.job_id === retryId);
  const byName = (name: string) => retried.filter((step) => step.name === name);
  // Every step before the failed one is a hit; the failed one runs.
  expect(byName("convert")).toEqual([
    expect.objectContaining({ status: "skipped", cache_hit: true }),
  ]);
  expect(byName("transcribe")).toEqual([
    expect.objectContaining({ status: "done", cache_hit: false }),
  ]);
  const { data: retryJob } = await admin.from("jobs").select("status").eq("id", retryId).single();
  expect(retryJob).toEqual({ status: "done" });
});
