import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { unchangedAnswerScript } from "../test-support/ai-script.ts";
import {
  createTestUser,
  deleteTestUser,
  signInLink,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// Going back (the restore job) and the versions list. The owner's change box
// is removed for now (app_docs/change-requests.md), so the third version comes
// from Start over. This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
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

interface VersionRecord {
  id: string;
  number: number;
  parent_id: string | null;
  restored_from_id: string | null;
  request: string | null;
  change_title: string | null;
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
    .select(
      "id, number, parent_id, restored_from_id, request, change_title, change_summary, r2_key",
    )
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
    .select(
      "id, kind, status, request, restore_version_id, error_tail, failure_kind, failure_rules",
    )
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

function versionItem(number: number) {
  return page.locator(`[data-testid="version-item"][data-version-number="${number}"]`);
}

// Opens a version's details with its arrow (a no-op when open) and returns
// them: what the owner asked, what changed and Go back live there.
async function versionDetails(number: number) {
  const toggle = versionItem(number).getByTestId("version-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return versionItem(number).getByTestId("version-details");
}

async function goBackButton(number: number) {
  return (await versionDetails(number)).getByRole("button", { name: "Go back to this" });
}

async function noReloadMarker() {
  return page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload);
}

async function runWorker(script: string) {
  return runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_AI_SCRIPT: script });
}

// Start over is the only way to a third version now: it queues a start_over
// job, and the worker decides again from version 1 with an answer that keeps
// its bytes, saving version 3.
async function startOverToVersion3() {
  await page.getByTestId("start-over").click();
  await expect.poll(async () => (await jobsOf("start_over")).length).toBe(1);
  const worker = await runWorker(await unchangedAnswerScript(scriptDir));
  expect(worker.code, worker.output).toBe(0);
  await expect(versionItem(3).getByTestId("version-current")).toBeVisible({ timeout: 30_000 });
}

test("going back makes a new version copying the old one, and going back again", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
  await startOverToVersion3();

  const before = await versionsOf();
  expect(before.map((v) => v.number)).toEqual([1, 2, 3]);
  const [v1, , v3] = before;
  const bytesBefore = await Promise.all(before.map((v) => bytesOf(v.r2_key)));

  await (await goBackButton(1)).click();
  await expect
    .poll(async () => (await jobsOf("restore")).map((j) => j.restore_version_id))
    .toEqual([v1!.id]);
  expect((await jobsOf("restore")).map((j) => j.kind)).toEqual(["restore"]);
  const unchanged = await unchangedAnswerScript(scriptDir);
  const first = await runWorker(unchanged);
  expect(first.code, first.output).toBe(0);

  const v4 = (await versionsOf()).find((v) => v.number === 4)!;
  expect(v4).toMatchObject({
    parent_id: v3!.id,
    restored_from_id: v1!.id,
    request: null,
    change_title: null,
    change_summary: "Back to how v1 looked",
  });
  expect(await bytesOf(v4.r2_key)).toBe(bytesBefore[0]);
  expect((await reelRow()).current_version_id).toBe(v4.id);
  await expect(page.locator(`[data-preview-version="${v4.id}"][data-preview="ready"]`)).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(versionItem(4).getByTestId("version-title")).toHaveText("Back to v1");
  await expect((await versionDetails(4)).getByTestId("version-origin")).toHaveText("Back to v1");

  await (await goBackButton(3)).click();
  await expect.poll(async () => (await jobsOf("restore")).length).toBe(2);
  const second = await runWorker(unchanged);
  expect(second.code, second.output).toBe(0);

  const v5 = (await versionsOf()).find((v) => v.number === 5)!;
  expect(v5).toMatchObject({ parent_id: v4.id, restored_from_id: v3!.id });
  expect(await bytesOf(v5.r2_key)).toBe(bytesBefore[2]);
  await expect(versionItem(5).getByTestId("version-title")).toHaveText("Back to v3");
  await expect((await versionDetails(5)).getByTestId("version-origin")).toHaveText("Back to v3");
  await expect(versionItem(5).getByTestId("version-current")).toBeVisible();

  // History is never rewritten: v1 to v3 rows and bytes, and v4's, are as they were.
  const after = await versionsOf();
  expect(after.slice(0, 4)).toEqual([...before, v4]);
  for (const [index, version] of before.entries()) {
    expect(await bytesOf(version.r2_key)).toBe(bytesBefore[index]);
  }
  expect(await noReloadMarker()).toBe("marker");
});

test("another owner cannot queue a going back, and a going back needs a version", async () => {
  other = await createTestUser(admin, "change-requests-other");
  const clientB = (await signedInClient(admin, other.email)).client;
  const [v1] = await versionsOf();
  const intruder = await clientB
    .from("jobs")
    .insert({ reel_id: reel!.reelId, kind: "restore", restore_version_id: v1!.id });
  expect(intruder.error).not.toBeNull();

  const clientA = (await signedInClient(admin, owner.email)).client;
  const empty = await clientA.from("jobs").insert({ reel_id: reel!.reelId, kind: "restore" });
  expect(empty.error).not.toBeNull();
  expect(await jobsOf("restore")).toHaveLength(2);
  expect(await claimableJobIds(admin)).toEqual([]);
});
