import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { expect, test } from "@playwright/test";
import { SHORT_SPEECH_ANSWER } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import {
  insertQueuedReel,
  pipelineManifest,
  seedPipelineCache,
} from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce, startWorkerOnce } from "../test-support/worker.ts";

// The lease and the temporary names, proved: a worker killed (SIGKILL, its
// whole process group) while the transcribe double has half of its output
// written leaves nothing stored or recorded; once the lease runs out another
// worker takes the job again and runs the step from the start.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const PIPELINE_FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let scratch: string | null = null;

async function hasFile(dir: string, name: string): Promise<boolean> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's temp folder
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.some((entry) => entry === name || entry.endsWith(`/${name}`));
}

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "crash-resume");
});

test.afterAll(async () => {
  for (const key of await storage.list(CACHE_PREFIX)) await storage.delete(key);
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a worker killed mid-step stores nothing half-written, and the job resumes after its lease", async () => {
  test.setTimeout(180_000);
  scratch = await mkdtemp(join(tmpdir(), "crash-resume-"));
  const { reelId, jobId } = await insertQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
  });
  await seedPipelineCache(storage, CACHE_PREFIX, { except: ["transcribe"] });
  const env = {
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_STEPS: "true",
    E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
    WORKER_SCRATCH_DIR: scratch,
  };

  const worker = startWorkerOnce({ ...env, E2E_MOCK_STEP_FAULT: "transcribe:half" });
  try {
    await expect
      .poll(() => hasFile(scratch!, "transcript.json.part"), { timeout: 60_000 })
      .toBe(true);
  } finally {
    worker.killGroup();
  }
  await worker.exited;

  expect(await storage.list(`${CACHE_PREFIX}cache/transcribe/`)).toEqual([]);
  const { data: noRecords } = await admin
    .from("stored_files")
    .select("r2_key")
    .eq("reel_id", reelId)
    .eq("step", "transcribe");
  expect(noRecords).toEqual([]);

  // The lease runs out: a minute before the claim, on the database clock.
  const { data: held } = await admin
    .from("jobs")
    .select("status, started_at")
    .eq("id", jobId)
    .single();
  expect(held!.status).toBe("running");
  const expired = await admin
    .from("jobs")
    .update({
      lease_expires_at: new Date(Date.parse(held!.started_at as string) - 60_000).toISOString(),
    })
    .eq("id", jobId);
  expect(expired.error).toBeNull();

  const second = await runWorkerOnce(env);
  expect(second.code, second.output).toBe(0);

  const { data: job } = await admin
    .from("jobs")
    .select("status, attempts")
    .eq("id", jobId)
    .single();
  expect(job).toEqual({ status: "done", attempts: 2 });
  const { data: transcribes } = await admin
    .from("steps")
    .select("status, cache_hit, error_tail")
    .eq("job_id", jobId)
    .eq("name", "transcribe")
    .order("started_at");
  expect(transcribes).toEqual([
    {
      status: "failed",
      cache_hit: false,
      error_tail: expect.stringContaining("the worker stopped during this step"),
    },
    { status: "done", cache_hit: false, error_tail: null },
  ]);

  const manifest = await pipelineManifest();
  const step = manifest.steps.find((entry) => entry.name === "transcribe")!;
  const key = `${CACHE_PREFIX}cache/transcribe/${step.fingerprint}/transcript.json`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  const fixture = await readFile(new URL("transcribe/transcript.json", PIPELINE_FIXTURES));
  expect(Buffer.from((await storage.get(key))!)).toEqual(fixture);
  const { data: records } = await admin
    .from("stored_files")
    .select("r2_key")
    .eq("reel_id", reelId)
    .eq("step", "transcribe");
  expect(records).toEqual([{ r2_key: key }]);
});
