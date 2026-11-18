import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Download, type Page, expect, test } from "@playwright/test";
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
// How long a finished export is kept (`export_keep_interval()`).
const KEEP_MS = 48 * 3600 * 1000;
const EDITING_OFF = "Editing is off while this reel exports. Cancel the export to edit now";
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

const panel = () => page.getByTestId("export-panel");
const progressPercent = async () =>
  Number((await page.getByTestId("export-progress").getAttribute("data-percent")) || 0);
const reelTile = () => page.getByRole("list", { name: "Reels" }).getByRole("listitem").first();

async function openReelPage() {
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
}

// The downloads the page started, by itself or by a click.
function countDownloads() {
  let count = 0;
  const listener = () => (count += 1);
  page.on("download", listener);
  return { count: () => count, stop: () => page.off("download", listener) };
}

async function expectStub(download: Download) {
  expect(download.suggestedFilename()).toMatch(/^reel-v2-\d{8}-\d{4}\.mp4$/);
  const path = await download.path();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright's own download file
  expect(new Uint8Array(await readFile(path))).toEqual(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    new Uint8Array(await readFile(STUB)),
  );
}

// While the reel exports, its editing controls are off and say why.
async function expectEditingOff() {
  await expect(page.getByTestId("export-editing-off")).toContainText(EDITING_OFF);
  await expect(page.getByTestId("start-over")).toBeDisabled();
  await expect(page.getByTestId("start-over")).toHaveAttribute("title", EDITING_OFF);
  await expect(page.locator("#versions-status")).toHaveText(EDITING_OFF);
  // Every font pair but the chosen one (which never queues anything).
  const others = page
    .getByTestId("font-pair-picker")
    .locator('[role="radio"][data-selected="false"]');
  await expect(others.first()).toBeDisabled();
  await expect(others.first()).toHaveAttribute("title", EDITING_OFF);
}

async function expectEditingOn() {
  await expect(page.getByTestId("export-editing-off")).toHaveCount(0);
  await expect(page.getByTestId("start-over")).toBeEnabled();
  await expect(page.locator("#versions-status")).toHaveText("");
}

test("Export never blocks: the owner leaves while it renders, and the kept file is offered in the list and on the page", async ({
  baseURL,
}) => {
  test.setTimeout(180_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  // The reels list before any export: a bin, no Download icon.
  await expect(reelTile().getByTestId("delete-reel")).toBeVisible();
  await expect(reelTile().getByTestId("download-export")).toHaveCount(0);
  await openReelPage();

  const button = page.getByTestId("export-button");
  await expect(button).toBeEnabled();
  await expect(panel()).toHaveAttribute("data-export-state", "idle");
  await expect(page.getByTestId("export-download")).toHaveCount(0);
  await expectEditingOn();
  await button.click();

  // Progress on the reel itself, with Cancel; no dialog covers the page.
  await expect(panel()).toHaveAttribute("data-export-state", "exporting");
  await expect(page.getByTestId("export-status")).toHaveText("Exporting… waiting to start");
  // Indeterminate before the render step runs.
  await expect(page.getByTestId("export-progress")).toHaveAttribute("data-percent", "");
  await expect(page.getByTestId("export-cancel")).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(button).toHaveCount(0);
  const { current_version_id: versionId } = await reelRow();
  await expect
    .poll(renderJobs)
    .toEqual([
      expect.objectContaining({ kind: "render", status: "queued", version_id: versionId }),
    ]);
  await expect
    .poll(() => eventsNamed(events, "studio_export_requested"))
    .toEqual([
      { event: "studio_export_requested", properties: { app: "studio", reel_id: reel!.reelId } },
    ]);
  // Editing this reel is off while it exports, with the reason shown.
  await expectEditingOff();

  const downloads = countDownloads();
  try {
    // The render double replays the render's progress over 25 seconds (the
    // worker writes progress throttled, so a shorter render shows one value).
    const worker = runWorkerOnce(
      { R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER_SECONDS: "25" },
      { timeoutMs: 90_000 },
    );

    // The line follows the render step's live percent and rises.
    await expect.poll(progressPercent, { timeout: 60_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("export-status")).toHaveText(/^Exporting… \d+%$/);
    const first = await progressPercent();
    await expect.poll(progressPercent, { timeout: 30_000 }).toBeGreaterThan(first);

    // Leaving the reel never cancels: the owner goes to the reels list while
    // the render runs.
    await page.getByRole("link", { name: "Back to your reels" }).click();
    await expect(page).toHaveURL("/studio");
    await expect(reelTile().getByTestId("delete-reel")).toBeVisible();
    expect((await renderJobs()).map((job) => job.status)).not.toContain("cancelled");
    // The rest of the studio stays usable meanwhile.
    await expect(page.getByRole("button", { name: "Upload a reel" })).toBeEnabled();

    const result = await worker;
    expect(result.code, result.output).toBe(0);
    expect((await renderJobs()).map((job) => job.status)).toEqual(["done"]);

    // The Download icon appears beside the bin once the export is kept, with
    // no reload, and nothing downloads or pops up by itself away from the reel.
    const icon = reelTile().getByTestId("download-export");
    await expect(icon).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(downloads.count()).toBe(0);
    const iconBox = (await icon.boundingBox())!;
    const binBox = (await reelTile().getByTestId("delete-reel").boundingBox())!;
    expect(Math.abs(iconBox.y - binBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(iconBox.x + iconBox.width - binBox.x)).toBeLessThanOrEqual(1);
    // The icon never opens the reel.
    const fromList = page.waitForEvent("download", { timeout: 30_000 });
    await icon.click();
    await expectStub(await fromList);
    await expect(page).toHaveURL("/studio");
    await expect
      .poll(() => eventsNamed(events, "studio_export_downloaded"))
      .toEqual([
        { event: "studio_export_downloaded", properties: { app: "studio", reel_id: reel!.reelId } },
      ]);

    const renderLines = (await stepLines(admin, reel!.reelId)).filter(
      (line) => line.name === "render",
    );
    expect(renderLines.map((line) => line.summary)).toEqual([expect.stringMatching(/^exported, /)]);
    expect((await reelRow()).status).toBe("processed");
    const [job] = await renderJobs();
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
    // The file is kept 48 hours.
    expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBe(KEEP_MS);
    written.add(row!.r2_key);
    expect((await storage.head(row!.r2_key))?.bytes).toBe(stubBytes);

    // Back on the reel: Download is offered, Export is open again, editing is
    // back on, and opening the page downloads nothing by itself.
    await openReelPage();
    await expect(panel()).toHaveAttribute("data-export-state", "idle");
    await expect(page.getByTestId("export-button")).toBeEnabled();
    await expectEditingOn();
    const kept = page.getByTestId("export-download");
    await expect(kept).toHaveText("Download v2");
    expect(downloads.count()).toBe(1);
    const fromPage = page.waitForEvent("download", { timeout: 30_000 });
    await kept.click();
    await expectStub(await fromPage);
    expect(downloads.count()).toBe(2);
  } finally {
    downloads.stop();
  }
});

test("still on the reel's page when the export finishes: the file downloads by itself", async () => {
  test.setTimeout(120_000);
  const before = await exportsOf();
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
  await page.getByTestId("export-button").click();
  await expect(panel()).toHaveAttribute("data-export-state", "exporting");

  const downloaded = page.waitForEvent("download", { timeout: 90_000 });
  const result = await runWorkerOnce(
    { R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER_SECONDS: "5" },
    { timeoutMs: 90_000 },
  );
  expect(result.code, result.output).toBe(0);
  await expectStub(await downloaded);
  await expect(page.getByTestId("export-message")).toHaveText("Downloaded");
  await expect(panel()).toHaveAttribute("data-export-state", "idle");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(await noReloadMarker()).toBe("marker");

  // The newer export is the kept one now: Download gives it.
  const after = await exportsOf();
  expect(after).toHaveLength(before.length + 1);
  for (const row of after) written.add(row.r2_key);
  await expect(page.getByTestId("export-download")).toHaveText("Download v2");
  await expect(page.getByTestId("export-button")).toBeEnabled();
  await expectEditingOn();
});

test("only Cancel stops an export: leaving and coming back keeps it, Cancel ends it with no file", async () => {
  test.setTimeout(120_000);
  const before = await exportsOf();
  const downloads = countDownloads();
  try {
    await page.getByTestId("export-button").click();
    await expect(panel()).toHaveAttribute("data-export-state", "exporting");
    // Long enough that only a cancel ends it in time.
    const worker = startWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER_SECONDS: "90" });
    try {
      await expect.poll(progressPercent, { timeout: 60_000 }).toBeGreaterThan(0);
      // Leave for the reels list and come back: the export is still running,
      // and the page shows it again with its Cancel.
      await page.getByRole("link", { name: "Back to your reels" }).click();
      await expect(page).toHaveURL("/studio");
      await openReelPage();
      await expect(panel()).toHaveAttribute("data-export-state", "exporting");
      await expect(page.getByTestId("export-status")).toHaveText(/^Exporting… /);
      expect((await renderJobs()).at(-1)).toMatchObject({ status: "running" });
      await expectEditingOff();

      await page.getByTestId("export-cancel").click();
      await expect(panel()).toHaveAttribute("data-export-state", "idle");

      const exited = await worker.exited;
      expect(exited.output).toMatch(/cancelled, leaving it/);
    } finally {
      worker.killGroup();
    }
    expect((await renderJobs()).at(-1)).toMatchObject({ status: "cancelled" });
    expect(await exportsOf()).toEqual(before);
    expect(await storage.list(`${CACHE_PREFIX}exports/${reel!.reelId}/`)).toEqual(
      before.map((row) => row.r2_key).sort(),
    );
    await expect(page.getByTestId("export-button")).toBeEnabled();
    await expectEditingOn();
    // The earlier export is still the kept one.
    await expect(page.getByTestId("export-download")).toHaveText("Download v2");
    expect(downloads.count()).toBe(0);
  } finally {
    downloads.stop();
  }
});

test("Cancel while queued: the render is never claimed", async () => {
  const before = await exportsOf();
  const known = new Set((await renderJobs()).map((job) => job.id));
  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("export-status")).toHaveText("Exporting… waiting to start");
  await expect
    .poll(async () => (await renderJobs()).filter((job) => !known.has(job.id)))
    .toEqual([expect.objectContaining({ status: "queued" })]);
  // Escape cancels nothing: there is no dialog to close.
  await page.keyboard.press("Escape");
  await expect(panel()).toHaveAttribute("data-export-state", "exporting");
  await page.getByTestId("export-cancel").click();
  await expect(panel()).toHaveAttribute("data-export-state", "idle");
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
});
