import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { seedPipelineCache } from "../test-support/pipeline.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

const ROOT = new URL("../../../", import.meta.url);
const CLIP = new URL("fixtures/footage/short-speech.mp4", ROOT);
const CHANGE_SCRIPT = new URL("fixtures/decide/change-request.json", ROOT).pathname;
const FAIL_SCRIPT = new URL("fixtures/decide/fail-twice.json", ROOT).pathname;
// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const REQUEST = "no accent on 'work'";

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
const storedKeys: string[] = [];
let owner: { id: string; email: string };
let reelId: string;

interface Version {
  id: string;
  number: number;
  r2_key: string;
  request: string | null;
  change_summary: string | null;
  restored_from_id: string | null;
  parent_id: string | null;
}

async function versions(): Promise<Version[]> {
  const { data, error } = await admin
    .from("versions")
    .select("id, number, r2_key, request, change_summary, restored_from_id, parent_id")
    .eq("reel_id", reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  for (const version of data as Version[]) {
    if (!storedKeys.includes(version.r2_key)) storedKeys.push(version.r2_key);
  }
  return data as Version[];
}

async function reelRow(): Promise<{ status: string; current_version_id: string | null }> {
  const { data, error } = await admin
    .from("reels")
    .select("status, current_version_id")
    .eq("id", reelId)
    .single();
  if (error || !data) throw new Error(`reel not read: ${error?.message}`);
  return data as { status: string; current_version_id: string | null };
}

async function sha256(key: string): Promise<string> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`version object missing: ${key}`);
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashes(): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const version of await versions()) out[version.number] = await sha256(version.r2_key);
  return out;
}

async function openReel(page: Page, baseURL: string) {
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function markNoReload(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
}

async function expectNoReload(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
}

async function runWorker(script?: string) {
  return runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    ...(script ? { E2E_MOCK_AI_SCRIPT: script } : {}),
  });
}

const box = (page: Page) => page.getByLabel("Ask for a change");
const send = (page: Page) => page.getByRole("button", { name: "Send change" });
const row = (page: Page, number: number) =>
  page.locator(`[data-testid="version-row"][data-version="${number}"]`);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "changes");
  reelId = await insertReel(admin, {
    ownerId: owner.id,
    name: "short-speech.mp4",
    status: "uploaded",
  });

  // The uploaded clip, as the upload form leaves it, and every step's outputs.
  const sourceKey = `${CACHE_PREFIX}reels/${reelId}/source/original.mp4`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  const clip = new Uint8Array(await readFile(CLIP));
  await storage.put(sourceKey, clip);
  storedKeys.push(sourceKey, ...(await seedPipelineCache(storage, CACHE_PREFIX)));
  const reel = await admin
    .from("reels")
    .update({ source_key: sourceKey, source_bytes: clip.byteLength })
    .eq("id", reelId);
  if (reel.error) throw new Error(`reel not updated: ${reel.error.message}`);
  const job = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, kind: "process" });
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);

  // Every fixed step is a hit; version 1 from the preset, version 2 from the AI.
  const worker = await runWorker();
  if (worker.code !== 0) throw new Error(`worker failed:\n${worker.output}`);
  expect((await versions()).map((version) => version.number)).toEqual([1, 2]);
  expect((await reelRow()).status).toBe("processed");
});

test.afterAll(async () => {
  for (const key of storedKeys) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("the change box is disabled with a reason while a job runs, and opens when it ends", async ({
  page,
  baseURL,
}) => {
  const { data: running, error } = await admin
    .from("jobs")
    .insert({
      reel_id: reelId,
      owner_id: owner.id,
      kind: "process",
      status: "running",
      lease_holder: "e2e-elsewhere",
      lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !running) throw new Error(`job not inserted: ${error?.message}`);

  await openReel(page, baseURL!);
  await markNoReload(page);
  await expect(box(page)).toBeDisabled();
  await expect(send(page)).toBeDisabled();
  await expect(page.getByTestId("change-blocked")).toHaveText(
    "Wait for the running job to finish.",
  );
  await expect(row(page, 1).getByRole("button", { name: "Go back to this" })).toBeDisabled();

  await admin
    .from("jobs")
    .update({ status: "done", lease_expires_at: null, finished_at: new Date().toISOString() })
    .eq("id", running.id);
  await expect(box(page)).toBeEnabled({ timeout: 10_000 });
  await expect(send(page)).toBeEnabled();
  await expect(page.getByTestId("change-blocked")).toHaveCount(0);
  await expectNoReload(page);
});

test("a change request makes the next version current without a reload, running only decide", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  await openReel(page, baseURL!);
  await expect(page.getByTestId("current-version")).toHaveText("version 2");
  await markNoReload(page);

  await box(page).fill(`  ${REQUEST}  `);
  await send(page).click();
  await expect(box(page)).toHaveValue("");
  await expect(page.getByTestId("job-request").last()).toHaveText(`“${REQUEST}”`, {
    timeout: 10_000,
  });

  const { data: changeJobs } = await admin
    .from("jobs")
    .select("id, kind, request, status")
    .eq("reel_id", reelId)
    .eq("kind", "change");
  expect(changeJobs).toEqual([
    { id: expect.any(String), kind: "change", request: REQUEST, status: "queued" },
  ]);
  await expect
    .poll(() => eventsNamed(events, "studio_change_requested"))
    .toEqual([
      { event: "studio_change_requested", properties: { app: "studio", reel_id: reelId } },
    ]);

  const worker = await runWorker(CHANGE_SCRIPT);
  expect(worker.code, worker.output).toBe(0);

  await expect(page.getByTestId("current-version")).toHaveText("version 3", { timeout: 15_000 });
  const all = await versions();
  const v3 = all.find((version) => version.number === 3)!;
  expect(v3).toMatchObject({ request: REQUEST, parent_id: all[1]!.id });
  await expect
    .poll(() => page.evaluate(() => window.__preview?.versionId), { timeout: 15_000 })
    .toBe(v3.id);
  await expectNoReload(page);
  await expect(row(page, 3).getByTestId("version-label")).toHaveText(`"${REQUEST}"`);
  await expect(row(page, 3).getByTestId("version-summary")).toHaveText(v3.change_summary!);
  await expect(row(page, 3)).toContainText("current");

  // Only decide ran: every fixed step is absent from the change job.
  const { data: steps } = await admin
    .from("steps")
    .select("name, status")
    .eq("job_id", changeJobs![0]!.id);
  expect(steps).toEqual([{ name: "decide", status: "done" }]);
});

test("a change that fails twice leaves the current version and the reel as they were", async ({
  page,
  baseURL,
}) => {
  await openReel(page, baseURL!);
  await expect(page.getByTestId("current-version")).toHaveText("version 3");
  await box(page).fill("make it all broken");
  await send(page).click();
  await expect(page.getByTestId("change-blocked")).toBeVisible({ timeout: 10_000 });

  const worker = await runWorker(FAIL_SCRIPT);
  expect(worker.code, worker.output).toBe(1);

  const failedJob = page.getByRole("listitem").filter({ hasText: "make it all broken" });
  await expect(failedJob.getByTestId("job-status")).toHaveText("failed", { timeout: 15_000 });
  await expect(failedJob.locator("pre")).toContainText("decide failed twice");
  await expect(failedJob.locator("pre")).toContainText("round 1:");
  await expect(failedJob.locator("pre")).toContainText("round 2:");
  await expect(page.getByTestId("current-version")).toHaveText("version 3");
  await expect(page.getByTestId("reel-status")).toHaveText("processed");
  await expect(box(page)).toBeEnabled();

  const all = await versions();
  expect(all.map((version) => version.number)).toEqual([1, 2, 3]);
  expect(await reelRow()).toEqual({ status: "processed", current_version_id: all[2]!.id });
});

test("going back copies an old version into a new one, and can itself be undone", async ({
  page,
  baseURL,
}) => {
  const before = await hashes();
  expect(Object.keys(before)).toEqual(["1", "2", "3"]);
  await openReel(page, baseURL!);
  await markNoReload(page);
  await expect(row(page, 3).getByRole("button", { name: "Go back to this" })).toHaveCount(0);

  await row(page, 1).getByRole("button", { name: "Go back to this" }).click();
  await expect(page.getByTestId("job-request").last()).toHaveText("go back to version 1", {
    timeout: 10_000,
  });
  expect((await runWorker()).code).toBe(0);
  await expect(page.getByTestId("current-version")).toHaveText("version 4", { timeout: 15_000 });
  await expect(row(page, 4).getByTestId("version-label")).toHaveText("restored from v1");
  let all = await versions();
  const v4 = all[3]!;
  expect(v4).toMatchObject({ number: 4, restored_from_id: all[0]!.id, parent_id: all[2]!.id });
  expect(await sha256(v4.r2_key)).toBe(before[1]);
  await expect
    .poll(() => page.evaluate(() => window.__preview?.versionId), { timeout: 15_000 })
    .toBe(v4.id);

  await expect(row(page, 3).getByRole("button", { name: "Go back to this" })).toBeEnabled({
    timeout: 10_000,
  });
  await row(page, 3).getByRole("button", { name: "Go back to this" }).click();
  await expect(page.getByTestId("job-request").last()).toHaveText("go back to version 3", {
    timeout: 10_000,
  });
  expect((await runWorker()).code).toBe(0);
  await expect(page.getByTestId("current-version")).toHaveText("version 5", { timeout: 15_000 });
  await expect(row(page, 5).getByTestId("version-label")).toHaveText("restored from v3");
  all = await versions();
  expect(all[4]).toMatchObject({ number: 5, restored_from_id: all[2]!.id, parent_id: v4.id });
  expect(await sha256(all[4]!.r2_key)).toBe(before[3]);
  await expectNoReload(page);

  // History is never rewritten: every earlier object is byte for byte as it was.
  const after = await hashes();
  expect({ 1: after[1], 2: after[2], 3: after[3], 4: after[4] }).toEqual({
    ...before,
    4: before[1],
  });
});
