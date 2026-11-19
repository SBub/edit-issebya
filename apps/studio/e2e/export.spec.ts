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
const MAY_LEAVE = "You can leave this page, the export keeps going";
// The widths the header is measured at: the spec's desktop, a laptop and a
// phone.
const DESKTOP = { width: 1920, height: 1080 };
const WIDTHS = [DESKTOP, { width: 1280, height: 800 }, { width: 390, height: 844 }];
// The most a box may differ between two states, in CSS pixels.
const SHIFT_TOLERANCE = 0.5;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
type Boxes = Record<string, Box>;
// The page's own probes, set before any page script runs (see beforeAll).
interface HeaderProbe {
  __headerBoxes: () => Boxes;
  __headerWatch?: HeaderWatch;
}
// One watch of the header between two states (see `watchHeader`).
interface HeaderWatch {
  // How many times the boxes were measured, and how many of those followed a
  // change to the header's tree.
  samples: number;
  changes: number;
  // The panel's `data-export-state` at each measure, repeats dropped.
  states: string[];
  low: Boxes;
  high: Boxes;
  end: () => void;
}
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
  // The boxes the no-shift checks compare, measured from the root box: the
  // header, each of its children (the back link, the title, the export slot),
  // what is under the header, and inside the slot the one action button
  // (Export or Cancel), the progress line, its bar and Download when shown.
  await page.addInitScript(() => {
    (window as unknown as HeaderProbe).__headerBoxes = () => {
      const header = document.querySelector("header");
      if (!header) return {};
      const part = (id: string) => header.querySelector(`[data-testid="${id}"]`);
      const found: Record<string, Element | null | undefined> = {
        root: document.documentElement,
        header,
        "under the header": header.nextElementSibling,
        "second under the header": header.nextElementSibling?.nextElementSibling,
        "Export or Cancel": part("export-button") ?? part("export-cancel"),
        "progress line": part("export-status"),
        "progress bar": part("export-progress"),
        Download: part("export-download"),
      };
      [...header.children].forEach((child, index) => {
        found[`header child ${index + 1} (${child.tagName.toLowerCase()})`] = child;
      });
      const boxes: Boxes = {};
      for (const [name, element] of Object.entries(found)) {
        if (!element) continue;
        const { left, top, width, height } = element.getBoundingClientRect();
        boxes[name] = { left, top, width, height };
      }
      return boxes;
    };
  });
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

// The parts every state must show (the rest come and go with the state).
const ALWAYS = [
  "root",
  "header",
  "under the header",
  "second under the header",
  "header child 1 (a)",
  "header child 2 (h1)",
  "header child 3 (section)",
  "Export or Cancel",
];
const SIDES = ["left", "top", "width", "height"] as const;
// The first box each part had at each width. Every later state is held to it,
// across the whole file: nothing in the header may move or change size.
const firstBoxes = new Map<string, Box>();

function expectSameBoxes(boxes: Boxes, width: number, state: string) {
  for (const name of ALWAYS) {
    expect(boxes, `${name} at "${state}", ${width} wide`).toHaveProperty([name]);
  }
  const root = boxes.root!;
  const header = boxes.header!;
  for (const [name, box] of Object.entries(boxes)) {
    const key = `${width} wide, ${name}`;
    const first = firstBoxes.get(key);
    if (!first) {
      firstBoxes.set(key, box);
    } else {
      for (const side of SIDES) {
        expect(
          Math.abs(box[side] - first[side]),
          `${key}: ${side} was ${first[side]}, is ${box[side]} at "${state}"`,
        ).toBeLessThanOrEqual(SHIFT_TOLERANCE);
      }
    }
    // Everything of the slot is inside the header's one row and the page.
    if (name.startsWith("under") || name.startsWith("second") || name === "root") continue;
    expect(box.top, `${key} at "${state}"`).toBeGreaterThanOrEqual(header.top);
    expect(box.top + box.height, `${key} at "${state}"`).toBeLessThanOrEqual(
      header.top + header.height,
    );
    expect(box.left, `${key} at "${state}"`).toBeGreaterThanOrEqual(root.left);
    expect(box.left + box.width, `${key} at "${state}"`).toBeLessThanOrEqual(
      root.left + root.width,
    );
  }
}

// The strict check: at the desktop, laptop and phone widths, the header, each
// of its children, what is under it and the parts of the export slot are
// where, and as large as, they were in every state before (0.5 px at most).
async function expectNoShift(state: string) {
  try {
    for (const viewport of WIDTHS) {
      await page.setViewportSize(viewport);
      const boxes = await page.evaluate(() => (window as unknown as HeaderProbe).__headerBoxes());
      expectSameBoxes(boxes, viewport.width, state);
    }
  } finally {
    await page.setViewportSize(DESKTOP);
  }
}

// Between two states too: from now on the page measures the same boxes and
// keeps the lowest and highest value of each side. It measures at once, after
// every change to the header's own tree (a MutationObserver, so each state the
// panel goes through is measured in the layout it was committed with, however
// few frames the machine draws), on every frame (what moves with no change to
// the tree, a transition) and a last time when the watch ends.
async function watchHeader() {
  await page.evaluate(() => {
    const probe = window as unknown as HeaderProbe;
    const header = document.querySelector("header");
    if (!header) throw new Error("no header to watch");
    const measure = () => {
      watch.samples += 1;
      const state = header
        .querySelector('[data-testid="export-panel"]')
        ?.getAttribute("data-export-state");
      if (state && watch.states.at(-1) !== state) watch.states.push(state);
      for (const [name, box] of Object.entries(probe.__headerBoxes())) {
        const low = (watch.low[name] ??= { ...box });
        const high = (watch.high[name] ??= { ...box });
        for (const side of ["left", "top", "width", "height"] as const) {
          low[side] = Math.min(low[side], box[side]);
          high[side] = Math.max(high[side], box[side]);
        }
      }
    };
    const changes = new MutationObserver(() => {
      watch.changes += 1;
      measure();
    });
    let frame = 0;
    const watch: HeaderWatch = {
      samples: 0,
      changes: 0,
      states: [],
      low: {},
      high: {},
      end: () => {
        changes.disconnect();
        cancelAnimationFrame(frame);
        measure();
      },
    };
    probe.__headerWatch = watch;
    changes.observe(header, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const onFrame = () => {
      measure();
      frame = requestAnimationFrame(onFrame);
    };
    onFrame();
  });
}

// Ends the watch: no box moved at any measure since `watchHeader`, and the
// panel was measured in each of `states`, in that order (the states the watched
// steps take it through). Nothing here counts frames: a slow machine draws few.
async function expectNoShiftWhileWatched(state: string, states: string[]) {
  const watch = await page.evaluate(() => {
    const held = (window as unknown as HeaderProbe).__headerWatch!;
    held.end();
    const { samples, changes, states, low, high } = held;
    return { samples, changes, states, low, high };
  });
  // The panel in each state it went through, so each change between two of
  // them was measured on both sides.
  expect(watch.states, `the panel's states during "${state}"`).toEqual(states);
  expect(watch.changes, `changes to the header during "${state}"`).toBeGreaterThanOrEqual(
    states.length - 1,
  );
  // The first measure, one after each change, the last one.
  expect(watch.samples).toBeGreaterThanOrEqual(watch.changes + 2);
  for (const name of ALWAYS) expect(watch.low, `${name} during "${state}"`).toHaveProperty([name]);
  for (const [name, low] of Object.entries(watch.low)) {
    const high = watch.high[name]!;
    for (const side of SIDES) {
      expect(
        high[side] - low[side],
        `${name}: ${side} went from ${low[side]} to ${high[side]} during "${state}"`,
      ).toBeLessThanOrEqual(SHIFT_TOLERANCE);
    }
  }
}

// While the reel exports, its editing controls are off and say why. The words
// are in the Versions column, never in the header.
async function expectEditingOff() {
  await expect(page.locator("header")).not.toContainText("Editing is off");
  await expect(page.locator("header")).not.toContainText(MAY_LEAVE);
  await expect(page.getByTestId("start-over")).toBeDisabled();
  await expect(page.getByTestId("start-over")).toHaveAttribute("title", EDITING_OFF);
  await expect(page.locator("#versions-status")).toHaveText(`${MAY_LEAVE}. ${EDITING_OFF}`);
  // Every font pair but the chosen one (which never queues anything).
  const others = page
    .getByTestId("font-pair-picker")
    .locator('[role="radio"][data-selected="false"]');
  await expect(others.first()).toBeDisabled();
  await expect(others.first()).toHaveAttribute("title", EDITING_OFF);
}

async function expectEditingOn() {
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
  // The boxes every later state is held to.
  await expectNoShift("before Export, no kept export");
  await button.click();

  // Progress on the reel itself, with Cancel; no dialog covers the page.
  await expect(panel()).toHaveAttribute("data-export-state", "exporting");
  await expect(page.getByTestId("export-status")).toHaveText("Exporting… waiting to start");
  // Indeterminate before the render step runs.
  await expect(page.getByTestId("export-progress")).toHaveAttribute("data-percent", "");
  await expect(page.getByTestId("export-cancel")).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(button).toHaveCount(0);
  // Cancel is where Export was, and nothing else in the header moved.
  await expectNoShift("waiting to start");
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
    await expectNoShift("the percent rising");
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
    // Download took its place in the slot: Export and the title did not move.
    await expectNoShift("Download shown");
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
  // Every change and every frame from the press on Export to the finished
  // download is measured.
  await watchHeader();
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
  await expect(page.getByTestId("export-download")).toBeVisible();
  // `Downloaded` and Download are inside the slot: nothing moved at any measure.
  await expectNoShiftWhileWatched("Export to the download by itself", [
    "idle",
    "exporting",
    "idle",
  ]);
  await expectNoShift("downloaded by itself");
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
      await expectNoShift("opened again while exporting");

      await watchHeader();
      await page.getByTestId("export-cancel").click();
      await expect(panel()).toHaveAttribute("data-export-state", "idle");
      await expect(page.getByTestId("export-button")).toBeEnabled();
      await expectNoShiftWhileWatched("Cancel while rendering", ["exporting", "idle"]);
      await expectNoShift("after Cancel");

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

// Each state of an export in turn, with no worker (the rows a worker would
// write are written here, so every percent is exact), measured at every width.
test("nothing in the header moves or changes size at any state of an export", async () => {
  test.setTimeout(120_000);
  const status = page.getByTestId("export-status");
  const known = new Set((await renderJobs()).map((job) => job.id));
  await expectNoShift("before Export, a kept export");
  await page.getByTestId("export-button").click();
  await expect(status).toHaveText("Exporting… waiting to start");
  await expectNoShift("waiting to start");

  const [job] = (await renderJobs()).filter((candidate) => !known.has(candidate.id));
  // Claimed, as far as the page can tell; the lease keeps a worker off it.
  const claimed = await admin
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    })
    .eq("id", job!.id);
  if (claimed.error) throw new Error(`job not updated: ${claimed.error.message}`);
  await expect(status).toHaveText("Exporting… getting ready");
  await expectNoShift("getting ready");

  const step = await admin
    .from("steps")
    .insert({
      job_id: job!.id,
      reel_id: reel!.reelId,
      owner_id: owner.id,
      name: "render",
      status: "running",
      progress_percent: 0,
    })
    .select("id")
    .single<{ id: string }>();
  if (step.error || !step.data) throw new Error(`step not inserted: ${step.error?.message}`);
  // One, two and three digits: the line and the bar stay where they are.
  for (const percent of [0, 7, 55, 100]) {
    const moved = await admin
      .from("steps")
      .update({ progress_percent: percent })
      .eq("id", step.data.id);
    if (moved.error) throw new Error(`step not updated: ${moved.error.message}`);
    await expect(status).toHaveText(`Exporting… ${percent}%`);
    await expect(page.getByTestId("export-progress")).toHaveAttribute(
      "data-percent",
      String(percent),
    );
    await expectNoShift(`${percent}%`);
  }
  const rendered = await admin.from("steps").update({ status: "done" }).eq("id", step.data.id);
  if (rendered.error) throw new Error(`step not updated: ${rendered.error.message}`);
  await expect(status).toHaveText("Exporting… finishing");
  await expectNoShift("finishing");

  await watchHeader();
  await page.getByTestId("export-cancel").click();
  await expect(panel()).toHaveAttribute("data-export-state", "idle");
  await expect(page.getByTestId("export-button")).toBeEnabled();
  await expectNoShiftWhileWatched("Cancel", ["exporting", "idle"]);
  await expectNoShift("after Cancel");
  await expect(page.getByTestId("export-download")).toHaveText("Download v2");
  expect((await renderJobs()).at(-1)).toMatchObject({ status: "cancelled" });
});
