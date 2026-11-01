import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";
import type { CapturedEvent } from "../src/lib/track";
import { eventsNamed, recordEvents } from "./events.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// What the render double copies (E2E_MOCK_RENDER=true in runWorkerOnce).
const STUB = fileURLToPath(new URL("../../../fixtures/render/stub-export.mp4", import.meta.url));
const DAY_MS = 24 * 3600 * 1000;
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

interface ExportRecord {
  id: string;
  job_id: string;
  version_id: string;
  owner_id: string;
  r2_key: string;
  bytes: number;
  created_at: string;
  expires_at: string;
}

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let page: Page;
let events: CapturedEvent[];
const written = new Set<string>();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "export");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  for (const key of reel.keys) written.add(key);

  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
    acceptDownloads: true,
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
  if (reel) {
    const { data } = await admin.from("exports").select("r2_key").eq("reel_id", reel.reelId);
    for (const row of (data ?? []) as { r2_key: string }[]) written.add(row.r2_key);
  }
  for (const key of written) await storage.delete(key);
  // The cascade removes the reel, its jobs, versions and exports.
  if (owner) await deleteTestUser(admin, owner.id);
});

async function exportsOf(): Promise<ExportRecord[]> {
  const { data, error } = await admin
    .from("exports")
    .select("id, job_id, version_id, owner_id, r2_key, bytes, created_at, expires_at")
    .eq("reel_id", reel!.reelId)
    .order("created_at");
  if (error) throw new Error(`exports not read: ${error.message}`);
  return (data ?? []) as ExportRecord[];
}

async function renderJobs() {
  const { data, error } = await admin
    .from("jobs")
    .select("id, kind, status, version_id")
    .eq("reel_id", reel!.reelId)
    .eq("kind", "render");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return data ?? [];
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

async function noReloadMarker() {
  return page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload);
}

test("Export renders the current version and the link downloads it without a reload", async ({
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const button = page.getByTestId("export-button");
  await expect(button).toBeEnabled();
  await expect(page.getByTestId("export-link")).toHaveCount(0);
  await button.click();

  const { current_version_id: versionId } = await reelRow();
  await expect
    .poll(renderJobs)
    .toEqual([
      expect.objectContaining({ kind: "render", status: "queued", version_id: versionId }),
    ]);
  await expect(button).toBeDisabled();
  await expect(page.getByTestId("export-blocked-reason")).toHaveText("Exporting this version...");
  await expect
    .poll(() => eventsNamed(events, "studio_export_requested"))
    .toEqual([
      { event: "studio_export_requested", properties: { app: "studio", reel_id: reel!.reelId } },
    ]);

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const link = page.getByTestId("export-link");
  await expect(link).toBeVisible({ timeout: 15_000 });
  await expect(link).toContainText("Download version 2");
  await expect(page.getByTestId("step-line").filter({ hasText: /^render: / })).toHaveText(
    /^render: exported, /,
  );
  await expect(button).toBeEnabled();
  expect(await noReloadMarker()).toBe("marker");
  expect((await reelRow()).status).toBe("processed");
  await expect(page.getByTestId("reel-status")).toHaveText("processed");

  const [job] = await renderJobs();
  expect(job).toMatchObject({ status: "done" });
  const [row] = await exportsOf();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
  const stubBytes = (await stat(STUB)).size;
  expect(row).toMatchObject({
    job_id: job!.id,
    version_id: versionId,
    owner_id: owner.id,
    r2_key: `${CACHE_PREFIX}exports/${reel!.reelId}/${row!.id}.mp4`,
    bytes: stubBytes,
  });
  expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBe(DAY_MS);
  written.add(row!.r2_key);
  expect((await storage.head(row!.r2_key))?.bytes).toBe(stubBytes);

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^reel-v2-\d{8}-\d{4}\.mp4$/);
  const path = await download.path();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright's own download file
  expect(new Uint8Array(await readFile(path))).toEqual(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    new Uint8Array(await readFile(STUB)),
  );
  await expect
    .poll(() => eventsNamed(events, "studio_export_downloaded"))
    .toEqual([
      { event: "studio_export_downloaded", properties: { app: "studio", reel_id: reel!.reelId } },
    ]);
});

test("an expired export shows expired, export again and no link", async () => {
  const [row] = await exportsOf();
  expect(row).toBeDefined();
  const deleted = await admin.from("exports").delete().eq("id", row!.id);
  expect(deleted.error).toBeNull();
  // Made 25 hours ago: the trigger sets expires_at an hour ago.
  const inserted = await admin.from("exports").insert({
    id: crypto.randomUUID(),
    reel_id: reel!.reelId,
    owner_id: owner.id,
    job_id: row!.job_id,
    version_id: row!.version_id,
    r2_key: row!.r2_key,
    bytes: row!.bytes,
    created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
  });
  expect(inserted.error).toBeNull();
  const [expired] = await exportsOf();
  expect(Date.parse(expired!.expires_at)).toBeLessThan(Date.now());

  await page.reload();
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("export-expired")).toHaveText("expired, export again");
  await expect(page.getByTestId("export-link")).toHaveCount(0);
  await expect(page.getByTestId("export-button")).toBeEnabled();
});
