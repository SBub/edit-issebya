import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { stepLines } from "../test-support/rows.ts";
import { claimableJobIds, runWorkerOnce, startWorkerOnce } from "../test-support/worker.ts";
import type { CapturedEvent } from "../src/lib/track";
import { eventsNamed, recordEvents } from "./events.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// What the render double copies (E2E_MOCK_RENDER=true in runWorkerOnce).
const STUB = fileURLToPath(new URL("../../../fixtures/render/stub-export.mp4", import.meta.url));
const HOUR_MS = 3600 * 1000;
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
    .select("id, kind, status, version_id, attempts, started_at")
    .eq("reel_id", reel!.reelId)
    .eq("kind", "render")
    .order("created_at");
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

// Nothing kept, nothing offered: the panel never shows a download link or an
// expiry, before or after an export.
async function expectNothingOffered() {
  await expect(page.getByTestId("export-link")).toHaveCount(0);
  await expect(page.getByTestId("export-expired")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /download/i })).toHaveCount(0);
  await expect(page.getByText(/expires|expired/)).toHaveCount(0);
}

const modal = () => page.getByTestId("export-modal");
const progressPercent = async () =>
  Number((await page.getByTestId("export-progress").getAttribute("data-percent")) || 0);

test("Export shows the render's progress in a modal, downloads the file by itself and closes", async ({
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
  await expectNothingOffered();
  await expect(modal()).toBeHidden();
  await button.click();

  await expect(modal()).toBeVisible();
  await expect(modal().getByRole("heading")).toHaveText("Exporting version 2");
  await expect(page.getByTestId("export-modal-status")).toHaveText("Waiting to start");
  // Indeterminate before the render step runs.
  await expect(page.getByTestId("export-progress")).toHaveAttribute("data-percent", "");
  const { current_version_id: versionId } = await reelRow();
  await expect
    .poll(renderJobs)
    .toEqual([
      expect.objectContaining({ kind: "render", status: "queued", version_id: versionId }),
    ]);
  await expect(page.getByTestId("export-blocked-reason")).toHaveText("Exporting this version...");
  await expect
    .poll(() => eventsNamed(events, "studio_export_requested"))
    .toEqual([
      { event: "studio_export_requested", properties: { app: "studio", reel_id: reel!.reelId } },
    ]);

  const downloaded = page.waitForEvent("download", { timeout: 90_000 });
  // The render double replays the render's progress over 25 seconds (the
  // worker writes progress throttled, so a shorter render shows one value).
  const worker = runWorkerOnce(
    { R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER_SECONDS: "25" },
    { timeoutMs: 90_000 },
  );

  // The bar follows the render step's live percent and rises.
  await expect.poll(progressPercent, { timeout: 60_000 }).toBeGreaterThan(0);
  const first = await progressPercent();
  await expect.poll(progressPercent, { timeout: 30_000 }).toBeGreaterThan(first);

  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^reel-v2-\d{8}-\d{4}\.mp4$/);
  const path = await download.path();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright's own download file
  expect(new Uint8Array(await readFile(path))).toEqual(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    new Uint8Array(await readFile(STUB)),
  );
  const result = await worker;
  expect(result.code, result.output).toBe(0);
  await expect(page.getByTestId("export-modal-status")).toHaveText("Downloaded");
  await expect(modal()).toBeHidden({ timeout: 10_000 });
  await expect
    .poll(() => eventsNamed(events, "studio_export_downloaded"))
    .toEqual([
      { event: "studio_export_downloaded", properties: { app: "studio", reel_id: reel!.reelId } },
    ]);

  const renderLines = (await stepLines(admin, reel!.reelId)).filter(
    (line) => line.name === "render",
  );
  expect(renderLines.map((line) => line.summary)).toEqual([expect.stringMatching(/^exported, /)]);
  await expect(button).toBeEnabled();
  expect(await noReloadMarker()).toBe("marker");
  expect((await reelRow()).status).toBe("processed");

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
  // The hand-over file lives 1 hour.
  expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBe(HOUR_MS);
  written.add(row!.r2_key);
  expect((await storage.head(row!.r2_key))?.bytes).toBe(stubBytes);
  await expectNothingOffered();
});

test("Cancel during the render stops it: no export, no download, Export again", async () => {
  test.setTimeout(120_000);
  const before = await exportsOf();
  let downloads = 0;
  const count = () => (downloads += 1);
  page.on("download", count);
  try {
    await page.getByTestId("export-button").click();
    await expect(modal()).toBeVisible();
    // Long enough that only a cancel ends it in time.
    const worker = startWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER_SECONDS: "90" });
    try {
      await expect.poll(progressPercent, { timeout: 60_000 }).toBeGreaterThan(0);
      await page.getByTestId("export-cancel").click();
      await expect(modal()).toBeHidden();

      const exited = await worker.exited;
      expect(exited.output).toMatch(/cancelled, leaving it/);
    } finally {
      worker.killGroup();
    }
    const jobs = await renderJobs();
    const cancelled = jobs.find((job) => job.status === "cancelled");
    expect(cancelled).toBeDefined();
    expect(await exportsOf()).toEqual(before);
    expect(await storage.list(`${CACHE_PREFIX}exports/${reel!.reelId}/`)).toEqual(
      before.map((row) => row.r2_key),
    );
    await expect(page.getByTestId("export-button")).toBeEnabled();
    await expectNothingOffered();
    expect(downloads).toBe(0);
  } finally {
    page.off("download", count);
  }
});

test("Cancel while queued: the render is never claimed", async () => {
  const before = await exportsOf();
  const known = new Set((await renderJobs()).map((job) => job.id));
  await page.getByTestId("export-button").click();
  await expect(modal()).toBeVisible();
  await expect(page.getByTestId("export-modal-status")).toHaveText("Waiting to start");
  await expect
    .poll(async () => (await renderJobs()).filter((job) => !known.has(job.id)))
    .toEqual([expect.objectContaining({ status: "queued" })]);
  // Escape closes the modal, which cancels the render.
  await page.keyboard.press("Escape");
  await expect(modal()).toBeHidden();
  await expect
    .poll(async () => (await renderJobs()).filter((job) => !known.has(job.id)))
    .toEqual([expect.objectContaining({ status: "cancelled" })]);

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);
  expect(worker.output).toMatch(/no job/);
  const [job] = (await renderJobs()).filter((candidate) => !known.has(candidate.id));
  expect(job).toMatchObject({ status: "cancelled", attempts: 0, started_at: null });
  expect(await exportsOf()).toEqual(before);
  await expect(page.getByTestId("export-button")).toBeEnabled();
  await expectNothingOffered();
});
