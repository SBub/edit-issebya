import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { expect, test } from "@playwright/test";
import { unchangedAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import {
  type QueuedReel,
  pipelineManifest,
  seedQueuedReel,
} from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce, spawnWorkerOnce } from "../test-support/worker.ts";

// Verification 6: a worker killed mid-step leaves only a temporary file; once
// its lease runs out a second worker re-runs the step, and the half-written
// file never becomes an output (no object, no stored_files row, no hit).
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const PIPELINE_FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: QueuedReel | null = null;
let scratch: string;
let scriptDir: string;
let script: string;
let killed: number | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "crash-resume");
  reel = await seedQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    skip: ["convert"],
  });
  scratch = await mkdtemp(join(tmpdir(), "crash-resume-scratch-"));
  scriptDir = await mkdtemp(join(tmpdir(), "crash-resume-"));
  script = await unchangedAnswerScript(scriptDir);
});

test.afterAll(async () => {
  if (killed !== null) {
    try {
      process.kill(-killed, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (reel) {
    // Leave nothing claimable for the next spec, even after a failure here.
    await admin
      .from("jobs")
      .delete()
      .eq("reel_id", reel.reelId)
      .in("status", ["queued", "running"]);
    const keys = new Set([...reel.keys, ...(await storage.list(CACHE_PREFIX))]);
    for (const key of keys) await storage.delete(key);
  }
  for (const dir of [scratch, scriptDir]) if (dir) await rm(dir, { recursive: true, force: true });
  if (owner) await deleteTestUser(admin, owner.id);
});

async function findFile(dir: string, name: string): Promise<boolean> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the spec's own scratch folder
  const entries = await readdir(dir, { recursive: true });
  return entries.some((entry) => entry.split("/").at(-1) === name);
}

async function convertRows() {
  const { data, error } = await admin
    .from("steps")
    .select("status, cache_hit")
    .eq("reel_id", reel!.reelId)
    .eq("name", "convert")
    .order("started_at");
  if (error) throw new Error(`steps not read: ${error.message}`);
  return data as { status: string; cache_hit: boolean }[];
}

async function convertFiles() {
  const { data, error } = await admin
    .from("stored_files")
    .select("r2_key, bytes")
    .eq("reel_id", reel!.reelId)
    .eq("step", "convert");
  if (error) throw new Error(`stored files not read: ${error.message}`);
  return data as { r2_key: string; bytes: number }[];
}

test("a step killed mid-write is re-run after the lease expires, never stored half", async () => {
  test.setTimeout(180_000);
  const env = {
    R2_KEY_PREFIX: CACHE_PREFIX,
    WORKER_SCRATCH_DIR: scratch,
    E2E_MOCK_AI_SCRIPT: script,
  };
  const crashing = spawnWorkerOnce({ ...env, E2E_MOCK_STEP_RUN: "convert:half" });
  killed = crashing.pid;
  await crashing.waitForLine("e2e: convert partial written");
  expect(await findFile(scratch, "converted.mp4.part")).toBe(true);
  process.kill(-crashing.pid, "SIGKILL");
  await crashing.exited;
  killed = null;

  expect(await storage.list(`${CACHE_PREFIX}cache/convert/`)).toEqual([]);
  expect(await convertFiles()).toEqual([]);
  expect(await convertRows()).toEqual([{ status: "running", cache_hit: false }]);

  // The lease runs out (a minute before it was claimed, on the database clock).
  const { data: claimed } = await admin
    .from("jobs")
    .select("started_at, attempts")
    .eq("id", reel!.jobId)
    .single();
  expect(claimed).toMatchObject({ attempts: 1 });
  const expired = new Date(Date.parse(claimed!.started_at as string) - 60_000).toISOString();
  await admin.from("jobs").update({ lease_expires_at: expired }).eq("id", reel!.jobId);

  const resumed = await runWorkerOnce({ ...env, E2E_MOCK_STEP_RUN: "convert:full" });
  expect(resumed.code, resumed.output).toBe(0);
  const { data: job } = await admin
    .from("jobs")
    .select("status, attempts")
    .eq("id", reel!.jobId)
    .single();
  expect(job).toEqual({ status: "done", attempts: 2 });
  expect(await convertRows()).toEqual([
    { status: "running", cache_hit: false },
    { status: "done", cache_hit: false },
  ]);

  const manifest = await pipelineManifest();
  const convert = manifest.steps.find((step) => step.name === "convert")!;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const full = await readFile(new URL(`convert/${convert.files[0]}`, PIPELINE_FIXTURES));
  const key = `${CACHE_PREFIX}cache/convert/${convert.fingerprint}/converted.mp4`;
  expect(await convertFiles()).toEqual([{ r2_key: key, bytes: full.length }]);
  expect(Buffer.from((await storage.get(key))!).equals(full)).toBe(true);
});
