import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { expect, test } from "@playwright/test";
import { SHORT_SPEECH_ANSWER } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { insertQueuedReel, seedPipelineCache } from "../test-support/pipeline-cache.ts";
import { jobsOf, reelStatus } from "../test-support/rows.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

const cachePrefixes: string[] = [];

// Each case gets its own cache folder: a step one case runs is stored in the
// cache, and would be a hit for the next case's reel (same fixture clip).
function freshCache() {
  // The worker reads this case's folder through R2_KEY_PREFIX.
  const prefix = `e2e-${crypto.randomUUID()}/`;
  cachePrefixes.push(prefix);
  return {
    prefix,
    // The pipeline step double (no real tools) and the committed decide answer.
    steps: {
      R2_KEY_PREFIX: prefix,
      E2E_MOCK_STEPS: "true",
      E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
    },
  };
}

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
  for (const prefix of cachePrefixes) {
    for (const key of await storage.list(prefix)) await storage.delete(key);
  }
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a step killed twice fails the job; Retry resumes at that step and finishes, live", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { prefix, steps } = freshCache();
  const { reelId, jobId } = await insertQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix,
  });
  await seedPipelineCache(storage, prefix, { except: ["transcribe"] });

  // The transcribe double kills itself with SIGKILL: transient, so it runs
  // once more, then the job fails.
  const first = await runWorkerOnce({ ...steps, E2E_MOCK_STEP_FAULT: "transcribe:signal" });
  expect(first.code, first.output).toBe(1);
  const { data: failed } = await admin
    .from("jobs")
    .select("status, failure_kind, failure_rules")
    .eq("id", jobId)
    .single();
  // Killed by a signal: transient, so the overlay offers Try again.
  expect(failed).toEqual({ status: "failed", failure_kind: "transient", failure_rules: null });
  const transcribes = (await stepsOf(reelId)).filter((step) => step.name === "transcribe");
  expect(transcribes.map((step) => step.status)).toEqual(["failed", "failed"]);
  expect(transcribes[0]!.summary).toMatch(/^transcribe failed, retrying once/);
  expect(transcribes[1]!.summary).not.toMatch(/retrying once/);

  const events = await recordEvents(page);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
  expect(await reelStatus(admin, reelId)).toBe("failed");
  await expect(page.locator("#versions-status")).toHaveText(
    "Processing failed; press Try again on the preview first",
  );

  const overlay = page.getByTestId("progress-overlay");
  await expect(overlay).toHaveAttribute("data-overlay-kind", "failure");
  await expect(overlay.getByTestId("overlay-headline")).toHaveText(
    "Could not finish listening to your words",
  );
  await overlay.getByTestId("overlay-try-again").click();
  await expect
    .poll(async () => (await jobsOf(admin, reelId)).map((job) => [job.status, job.retry_of_job_id]))
    .toEqual([
      ["failed", null],
      ["queued", jobId],
    ]);
  // The failed job is retried now: the overlay shows the queued job, no second Try again.
  await expect(overlay).toHaveAttribute("data-overlay-kind", "working", { timeout: 10_000 });
  await expect(page.getByTestId("overlay-try-again")).toHaveCount(0);
  expect(eventsNamed(events, "studio_failure_action")).toEqual([
    {
      event: "studio_failure_action",
      properties: {
        app: "studio",
        reel_id: reelId,
        job_id: jobId,
        action: "try_again",
        failure_kind: "transient",
        step: "transcribe",
        job_kind: "process",
      },
    },
  ]);
  const { data: retries } = await admin
    .from("jobs")
    .select("id, kind, status")
    .eq("retry_of_job_id", jobId);
  expect(retries).toEqual([{ id: expect.any(String), kind: "process", status: "queued" }]);
  const retryId = retries![0]!.id as string;

  const second = await runWorkerOnce(steps);
  expect(second.code, second.output).toBe(0);

  await expect
    .poll(async () => (await jobsOf(admin, reelId)).map((job) => job.status), { timeout: 10_000 })
    .toEqual(["failed", "done"]);
  await expect.poll(() => reelStatus(admin, reelId), { timeout: 10_000 }).toBe("processed");
  // The live page followed it: nothing failed is shown any more.
  await expect(page.getByTestId("overlay-headline")).toHaveCount(0, { timeout: 10_000 });
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

test("a retry that fails again offers a fresh Try again, live", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const { prefix, steps } = freshCache();
  const { reelId, jobId } = await insertQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix,
  });
  await seedPipelineCache(storage, prefix, { except: ["transcribe"] });

  const first = await runWorkerOnce({ ...steps, E2E_MOCK_STEP_FAULT: "transcribe:signal" });
  expect(first.code, first.output).toBe(1);
  const { data: failed } = await admin
    .from("jobs")
    .select("status, failure_kind")
    .eq("id", jobId)
    .single();
  expect(failed).toEqual({ status: "failed", failure_kind: "transient" });

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const overlay = page.getByTestId("progress-overlay");
  await expect(overlay).toHaveAttribute("data-overlay-kind", "failure");
  await overlay.getByTestId("overlay-try-again").click();
  await expect
    .poll(async () => (await jobsOf(admin, reelId)).map((job) => [job.status, job.retry_of_job_id]))
    .toEqual([
      ["failed", null],
      ["queued", jobId],
    ]);
  const retryId = (await jobsOf(admin, reelId))[1]!.id;
  await expect(overlay).toHaveAttribute("data-overlay-kind", "working", { timeout: 10_000 });

  // The retry fails the same way.
  const second = await runWorkerOnce({ ...steps, E2E_MOCK_STEP_FAULT: "transcribe:signal" });
  expect(second.code, second.output).toBe(1);
  await expect
    .poll(async () => (await jobsOf(admin, reelId)).map((job) => job.status), { timeout: 10_000 })
    .toEqual(["failed", "failed"]);

  // The overlay shows the retry's own failure with a fresh, enabled Try again
  // and no stale "Queued again." line.
  await expect(overlay).toHaveAttribute("data-overlay-kind", "failure", { timeout: 10_000 });
  await expect(overlay.getByTestId("overlay-headline")).toHaveText(
    "Could not finish listening to your words",
  );
  const tryAgain = overlay.getByTestId("overlay-try-again");
  await expect(tryAgain).toBeVisible();
  await expect(tryAgain).toBeEnabled();
  await expect(overlay.getByTestId("overlay-action-message")).toHaveCount(0);

  await tryAgain.click();
  await expect
    .poll(async () => (await jobsOf(admin, reelId)).map((job) => [job.status, job.retry_of_job_id]))
    .toEqual([
      ["failed", null],
      ["failed", jobId],
      ["queued", retryId],
    ]);

  // Finish the reel, so no claimable job is left for later specs.
  const third = await runWorkerOnce(steps);
  expect(third.code, third.output).toBe(0);
  await expect.poll(() => reelStatus(admin, reelId), { timeout: 10_000 }).toBe("processed");
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
});
