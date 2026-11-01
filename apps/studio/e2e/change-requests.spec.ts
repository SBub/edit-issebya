import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import {
  SHORT_SPEECH_ANSWER,
  brokenAnswerScript,
  unchangedAnswerScript,
} from "../test-support/ai-script.ts";
import {
  createTestUser,
  deleteTestUser,
  signInLink,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";
import type { CapturedEvent } from "../src/lib/track";
import { eventsNamed, recordEvents } from "./events.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const REQUEST = "no accent on 'work'";
const SECOND_REQUEST = "make the title bigger";
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

interface VersionRecord {
  id: string;
  number: number;
  parent_id: string | null;
  restored_from_id: string | null;
  request: string | null;
  change_summary: string | null;
  r2_key: string;
}

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let other: { id: string; email: string } | null = null;
let reel: ProcessedReel | null = null;
let scriptDir: string;
let page: Page;
let events: CapturedEvent[];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "change-requests");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  scriptDir = await mkdtemp(join(tmpdir(), "change-requests-"));

  // One page for every step, so the no-reload marker proves the live updates.
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
  events = await recordEvents(page);
});

test.afterAll(async () => {
  await page?.context().close();
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  const versions = reel ? await versionsOf() : [];
  for (const key of new Set([...(reel?.keys ?? []), ...versions.map((v) => v.r2_key)])) {
    await storage.delete(key);
  }
  if (owner) await deleteTestUser(admin, owner.id);
  if (other) await deleteTestUser(admin, other.id);
});

async function versionsOf(): Promise<VersionRecord[]> {
  const { data, error } = await admin
    .from("versions")
    .select("id, number, parent_id, restored_from_id, request, change_summary, r2_key")
    .eq("reel_id", reel!.reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  return (data ?? []) as VersionRecord[];
}

async function reelRow() {
  const { data, error } = await admin
    .from("reels")
    .select("status, current_version_id")
    .eq("id", reel!.reelId)
    .single();
  if (error || !data) throw new Error(`reel not read: ${error?.message}`);
  return data as { status: string; current_version_id: string };
}

async function jobsOf(kind: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("id, kind, status, request, restore_version_id, error_tail")
    .eq("reel_id", reel!.reelId)
    .eq("kind", kind)
    .order("created_at");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return data ?? [];
}

async function bytesOf(key: string): Promise<string> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`no blob at ${key}`);
  return new TextDecoder().decode(bytes);
}

function box() {
  return page.getByLabel("Ask for a change");
}

function versionItem(number: number) {
  return page.locator(`[data-testid="version-item"][data-version-number="${number}"]`);
}

async function noReloadMarker() {
  return page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload);
}

async function runWorker(script: string) {
  return runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_AI_SCRIPT: script });
}

test("the box and going back wait while a job is running, then open live", async ({ baseURL }) => {
  // A running process job whose lease is an hour ahead: never claimable.
  const { data: running, error } = await admin
    .from("jobs")
    .insert({
      reel_id: reel!.reelId,
      owner_id: owner.id,
      kind: "process",
      status: "running",
      lease_holder: "e2e-held",
      lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .select("id")
    .single();
  expect(error).toBeNull();

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-preview="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const reason = "A job is running on this reel; wait for it to finish.";
  await expect(box()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByTestId("change-blocked-reason")).toHaveText(reason);
  await expect(versionItem(1).getByRole("button", { name: "Go back to this" })).toBeDisabled();
  // The current version (2) offers no going back.
  await expect(versionItem(2).getByRole("button", { name: "Go back to this" })).toHaveCount(0);

  await admin
    .from("jobs")
    .update({ status: "done", finished_at: new Date().toISOString(), lease_expires_at: null })
    .eq("id", running!.id);
  await expect(box()).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId("change-blocked-reason")).toHaveText("");
  await expect(versionItem(1).getByRole("button", { name: "Go back to this" })).toBeEnabled();
  expect(await noReloadMarker()).toBe("marker");
});

test("a change becomes version 3 and the preview shows it without a reload", async () => {
  const before = await reelRow();
  await box().fill(`  ${REQUEST}  `);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("change-pending")).toHaveText(`Pending: ${REQUEST}`);
  await expect(box()).toHaveValue("");

  const changes = await jobsOf("change");
  expect(changes).toEqual([
    expect.objectContaining({ status: "queued", request: REQUEST, restore_version_id: null }),
  ]);

  const worker = await runWorker(SHORT_SPEECH_ANSWER);
  expect(worker.code, worker.output).toBe(0);

  const after = await reelRow();
  expect(after.status).toBe("processed");
  expect(after.current_version_id).not.toBe(before.current_version_id);
  const v3 = (await versionsOf()).find((v) => v.number === 3)!;
  expect(v3).toMatchObject({
    id: after.current_version_id,
    parent_id: before.current_version_id,
    request: REQUEST,
  });

  await expect(page.locator(`[data-preview-version="${v3.id}"][data-preview="ready"]`)).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(versionItem(3).getByTestId("version-origin")).toHaveText(`"${REQUEST}"`);
  await expect(versionItem(3).getByTestId("version-summary")).toHaveText(v3.change_summary!);
  await expect(versionItem(3).getByTestId("version-current")).toBeVisible();
  await expect(page.getByTestId("change-pending")).toHaveCount(0);
  expect(await noReloadMarker()).toBe("marker");

  // Only the decide step ran: no fixed step, no first version.
  const { data: steps } = await admin
    .from("steps")
    .select("name, status")
    .eq("job_id", changes[0]!.id);
  expect(steps).toEqual([{ name: "decide", status: "done" }]);

  // One event, the reel id only: never the request text.
  const sent = eventsNamed(events, "studio_change_requested");
  expect(sent).toEqual([
    { event: "studio_change_requested", properties: { app: "studio", reel_id: reel!.reelId } },
  ]);
  for (const entry of events) {
    expect(JSON.stringify(entry.properties ?? {})).not.toContain("accent on");
  }
});

test("a change refused twice fails the job and keeps version 3 and the reel processed", async () => {
  const v3 = (await reelRow()).current_version_id;
  await box().fill(SECOND_REQUEST);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("change-pending")).toHaveText(`Pending: ${SECOND_REQUEST}`);

  const worker = await runWorker(await brokenAnswerScript(scriptDir));
  expect(worker.code, worker.output).toBe(1);

  const failed = (await jobsOf("change")).at(-1)!;
  expect(failed).toMatchObject({ status: "failed", request: SECOND_REQUEST });
  expect(failed.error_tail).toContain("the answer failed twice, version 3 stays current");
  const job = page.locator('[data-testid="job-item"][data-job-kind="change"]').last();
  await expect(job.getByTestId("job-status")).toHaveText("failed", { timeout: 10_000 });
  await expect(job).toContainText("the answer failed twice, version 3 stays current");

  expect(await reelRow()).toEqual({ status: "processed", current_version_id: v3 });
  expect((await versionsOf()).map((v) => v.number)).toEqual([1, 2, 3]);
  await expect(page.getByTestId("reel-status")).toHaveText("processed");
  await expect(box()).toBeEnabled();
  expect(await noReloadMarker()).toBe("marker");
});

test("going back makes a new version copying the old one, and going back again", async () => {
  const before = await versionsOf();
  const [v1, , v3] = before;
  const bytesBefore = await Promise.all(before.map((v) => bytesOf(v.r2_key)));

  await versionItem(1).getByRole("button", { name: "Go back to this" }).click();
  await expect
    .poll(async () => (await jobsOf("restore")).map((j) => j.restore_version_id))
    .toEqual([v1!.id]);
  await expect(page.locator('[data-testid="job-item"][data-job-kind="restore"]')).toContainText(
    "go back to v1",
  );
  const unchanged = await unchangedAnswerScript(scriptDir);
  const first = await runWorker(unchanged);
  expect(first.code, first.output).toBe(0);

  const v4 = (await versionsOf()).find((v) => v.number === 4)!;
  expect(v4).toMatchObject({ parent_id: v3!.id, restored_from_id: v1!.id, request: null });
  expect(await bytesOf(v4.r2_key)).toBe(bytesBefore[0]);
  expect((await reelRow()).current_version_id).toBe(v4.id);
  await expect(page.locator(`[data-preview-version="${v4.id}"][data-preview="ready"]`)).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(versionItem(4).getByTestId("version-origin")).toHaveText("restored from v1");

  await versionItem(3).getByRole("button", { name: "Go back to this" }).click();
  await expect.poll(async () => (await jobsOf("restore")).length).toBe(2);
  const second = await runWorker(unchanged);
  expect(second.code, second.output).toBe(0);

  const v5 = (await versionsOf()).find((v) => v.number === 5)!;
  expect(v5).toMatchObject({ parent_id: v4.id, restored_from_id: v3!.id });
  expect(await bytesOf(v5.r2_key)).toBe(bytesBefore[2]);
  await expect(versionItem(5).getByTestId("version-origin")).toHaveText("restored from v3");
  await expect(versionItem(5).getByTestId("version-current")).toBeVisible();

  // History is never rewritten: v1 to v3 rows and bytes, and v4's, are as they were.
  const after = await versionsOf();
  expect(after.slice(0, 4)).toEqual([...before, v4]);
  for (const [index, version] of before.entries()) {
    expect(await bytesOf(version.r2_key)).toBe(bytesBefore[index]);
  }
  expect(await noReloadMarker()).toBe("marker");
});

test("another owner cannot queue a change, and a change needs words", async () => {
  other = await createTestUser(admin, "change-requests-other");
  const clientB = (await signedInClient(admin, other.email)).client;
  const intruder = await clientB
    .from("jobs")
    .insert({ reel_id: reel!.reelId, kind: "change", request: "lower" });
  expect(intruder.error).not.toBeNull();

  const clientA = (await signedInClient(admin, owner.email)).client;
  const empty = await clientA.from("jobs").insert({ reel_id: reel!.reelId, kind: "change" });
  expect(empty.error).not.toBeNull();
  expect(await jobsOf("change")).toHaveLength(2);
  expect(await claimableJobIds(admin)).toEqual([]);
});
