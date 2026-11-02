import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { expect, test } from "@playwright/test";
import { SHORT_SPEECH_ANSWER, USAGE_LIMIT_SCRIPT } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { insertQueuedReel, seedPipelineCache } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const REASON = "the usage limit is reached";

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let jobId: string | null = null;

interface JobRecord {
  status: string;
  attempts: number;
  waiting_reason: string | null;
  not_before: string | null;
  started_at: string | null;
}

async function readJob(): Promise<JobRecord> {
  const { data, error } = await admin
    .from("jobs")
    .select("status, attempts, waiting_reason, not_before, started_at")
    .eq("id", jobId!)
    .single();
  if (error || !data) throw new Error(`job not read: ${error?.message}`);
  return data as JobRecord;
}

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "waiting-ai");
});

test.afterAll(async () => {
  // No waiting job may be left to turn claimable later.
  if (jobId) await admin.from("jobs").delete().eq("id", jobId);
  for (const key of await storage.list(CACHE_PREFIX)) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a usage limit makes the job wait with its next try shown live, then it is taken again", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const queued = await insertQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
  });
  jobId = queued.jobId;
  await seedPipelineCache(storage, CACHE_PREFIX);

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${queued.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const first = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: USAGE_LIMIT_SCRIPT,
  });
  const waiting = await readJob();
  expect(waiting, first.output).toMatchObject({
    status: "waiting_ai",
    attempts: 1,
    waiting_reason: REASON,
  });
  // 15 minutes after the claim; the two stamps come from two clocks (the
  // worker's and the database's), so with a minute either way.
  const minutes = (Date.parse(waiting.not_before!) - Date.parse(waiting.started_at!)) / 60_000;
  expect(minutes).toBeGreaterThan(14);
  expect(minutes).toBeLessThan(16);

  const { data: decide } = await admin
    .from("steps")
    .select("status, error_tail")
    .eq("job_id", jobId)
    .eq("name", "decide");
  expect(decide).toEqual([{ status: "waiting", error_tail: REASON }]);

  // HH:MM in the page's own time zone, from the row's not_before.
  const nextTry = await page.evaluate((iso) => {
    const at = new Date(iso);
    const two = (value: number) => String(value).padStart(2, "0");
    return `${two(at.getHours())}:${two(at.getMinutes())}`;
  }, waiting.not_before!);
  await expect(page.getByTestId("job-waiting-ai")).toHaveText(
    `Waiting for the AI: ${REASON}. Next try at ${nextTry}.`,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("job-status")).toHaveText("waiting_ai");

  // The next try is due: an hour in the past on any clock.
  const due = await admin
    .from("jobs")
    .update({ not_before: new Date(Date.now() - 3_600_000).toISOString() })
    .eq("id", jobId);
  expect(due.error).toBeNull();
  const second = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
  });
  expect(second.code, second.output).toBe(0);
  expect(await readJob()).toMatchObject({
    status: "done",
    attempts: 2,
    waiting_reason: null,
    not_before: null,
  });

  await expect(page.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  await expect(page.getByTestId("job-waiting-ai")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
});
