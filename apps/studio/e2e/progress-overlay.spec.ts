import { ISSEBYA_PRESET, parseEdit, transcriptSchema } from "@edit-issebya/edit";
import { readFile } from "node:fs/promises";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { ruler } from "../test-support/ruler.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

// The reel page's progress overlay (app_docs/status.md): a scripted job's
// plain words and progress over the preview at both sizes, at the top right
// (its top edge on the preview frame's, its right edge on the edit area's
// content right, collapsed and expanded) with a white fill, never blocking the
// player's controls, and the automatic switch to a newly saved version at the
// same time and play state, with "New version N".

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const TRANSCRIPT = new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
const extraKeys: string[] = [];
let versionCount = 2;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "progress-overlay");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
});

test.afterAll(async () => {
  for (const key of [...(reel?.keys ?? []), ...extraKeys]) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

async function openReel(page: Page, baseURL: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await routePreviewCdn(page);
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-preview="ready"]')).toBeVisible({ timeout: 30_000 });
}

function playerTime(page: Page): Promise<number> {
  return page
    .locator("hyperframes-player")
    .evaluate((el) => (el as unknown as { currentTime: number }).currentTime);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element has no box");
  return found;
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function expectNoPageScroll(page: Page) {
  const sizes = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(sizes.scrollHeight).toBe(sizes.clientHeight);
}

// The overlay lies inside the preview, clear of Play and the ruler (the one
// scrubber), and Play still answers a click while it shows.
async function expectOverlayNeverBlocks(page: Page) {
  const overlay = await box(page.getByTestId("progress-overlay"));
  const preview = await box(page.locator('section[aria-labelledby="preview-heading"]'));
  expect(overlay.x).toBeGreaterThanOrEqual(preview.x - 1);
  expect(overlay.y).toBeGreaterThanOrEqual(preview.y - 1);
  expect(overlay.x + overlay.width).toBeLessThanOrEqual(preview.x + preview.width + 1);
  expect(overlay.y + overlay.height).toBeLessThanOrEqual(preview.y + preview.height + 1);
  const play = page.getByRole("button", { name: "Play" });
  expect(intersects(overlay, await box(play))).toBe(false);
  expect(intersects(overlay, await box(ruler(page)))).toBe(false);
  await play.click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await expectNoPageScroll(page);
}

// The right edge of the edit area's content box (inside its padding and any
// scrollbar): the edge the control row's expand icon and the tracks panel end on.
function editContentRight(page: Page): Promise<number> {
  return page.getByTestId("edit-area").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(el).paddingRight);
    return rect.left + el.clientLeft + el.clientWidth - padding;
  });
}

// The card at the top right, like a notification: its top edge on the preview
// frame's top edge, its right edge on the edit area's content right (the same
// edge as the tracks panel's right while collapsed), no wider than max-w-xs,
// and its bar filled white (--color-primary) over the unfilled track.
async function expectOverlayTopRight(page: Page) {
  const overlay = page.getByTestId("progress-overlay");
  const card = await box(overlay);
  const frame = await box(page.getByTestId("preview-frame"));
  expect(Math.abs(card.y - frame.y)).toBeLessThanOrEqual(1);
  const right = await editContentRight(page);
  expect(Math.abs(card.x + card.width - right)).toBeLessThanOrEqual(1);
  const tracks = page.getByTestId("tracks");
  if ((await tracks.count()) > 0) {
    const panel = await box(tracks);
    expect(Math.abs(card.x + card.width - (panel.x + panel.width))).toBeLessThanOrEqual(1);
  }
  expect(card.width).toBeLessThanOrEqual(320 + 1);
  const fill = overlay.getByRole("progressbar").locator("> div");
  await expect(fill).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expectNoPageScroll(page);
}

// A running process job held by a worker that does not exist (its lease an
// hour ahead, so never claimable), with its step rows written by the spec.
async function scriptedJob(): Promise<string> {
  const { data, error } = await admin
    .from("jobs")
    .insert({
      reel_id: reel!.reelId,
      owner_id: owner.id,
      kind: "process",
      status: "running",
      lease_holder: "e2e-overlay-fake",
      lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`job not inserted: ${error?.message}`);
  return data.id;
}

async function stepRow(jobId: string, name: string, status: string): Promise<string> {
  const { data, error } = await admin
    .from("steps")
    .insert({ job_id: jobId, reel_id: reel!.reelId, owner_id: owner.id, name, status })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`step not inserted: ${error?.message}`);
  return data.id;
}

async function scriptedJobAtBothSizes(page: Page, baseURL: string, viewport: typeof DESKTOP) {
  const events = await recordEvents(page);
  await openReel(page, baseURL, viewport);
  await expect(page.getByTestId("progress-overlay")).toHaveCount(0);

  const jobId = await scriptedJob();
  await stepRow(jobId, "check_footage", "done");
  const convert = await stepRow(jobId, "convert", "running");
  const overlay = page.getByTestId("progress-overlay");
  await expect(overlay.getByTestId("overlay-words")).toHaveText("Preparing your video", {
    timeout: 10_000,
  });
  await expect(overlay.getByTestId("overlay-step")).toHaveText("Step 2 of 8");
  await expect(overlay.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "13");
  await expectOverlayNeverBlocks(page);
  await expectOverlayTopRight(page);

  await admin.from("steps").update({ status: "done" }).eq("id", convert);
  await stepRow(jobId, "decide", "running");
  await expect(overlay.getByTestId("overlay-words")).toHaveText("Styling your reel", {
    timeout: 10_000,
  });
  await expect(overlay.getByTestId("overlay-step")).toHaveText("Step 8 of 8");
  await expectOverlayNeverBlocks(page);
  await expectOverlayTopRight(page);
  // Expanded, the card still starts on the frame's top edge and ends on the
  // edit area's right content edge.
  await page.getByRole("button", { name: "Expand preview" }).click();
  await expect(page.getByRole("button", { name: "Collapse preview" })).toBeVisible();
  await expectOverlayTopRight(page);
  await page.getByRole("button", { name: "Collapse preview" }).click();
  await expect(page.getByRole("button", { name: "Expand preview" })).toBeVisible();

  await admin
    .from("jobs")
    .update({ status: "done", finished_at: new Date().toISOString(), lease_expires_at: null })
    .eq("id", jobId);
  await expect(overlay).toHaveCount(0, { timeout: 10_000 });
  expect(eventsNamed(events, "studio_failure_action")).toEqual([]);
}

test("1440x900: a scripted job's plain words over the preview, never blocking it", async ({
  page,
  baseURL,
}) => {
  await scriptedJobAtBothSizes(page, baseURL!, DESKTOP);
});

test("390x844: the same words and the overlay clear of the controls", async ({ page, baseURL }) => {
  await scriptedJobAtBothSizes(page, baseURL!, PHONE);
});

// The current version's edit with a new change summary, saved as the next
// current version (same content, a new id and number).
async function saveNextVersion(): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const stored = await storage.get(reel!.versionKey);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  versionCount += 1;
  const saved = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel!.reelId,
    edit: parsed.edit,
    changeSummary: `overlay version ${versionCount}`,
  });
  extraKeys.push(saved.key);
  return saved.id;
}

test("1440x900: a new version replaces the preview while playing, at the same time", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  await openReel(page, baseURL!, DESKTOP);
  await page.getByRole("button", { name: "Play" }).click();
  // The seeded reel is under 3 seconds and an ended player is paused, so the
  // new version is saved as soon as the clock moves, while it still plays.
  await expect.poll(() => playerTime(page), { timeout: 15_000 }).toBeGreaterThan(0);
  const before = await playerTime(page);

  const nextId = await saveNextVersion();
  const wrapper = page.locator(`[data-version-id="${nextId}"]`);
  await expect(wrapper).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("overlay-notice")).toHaveText(`New version ${versionCount}`);
  await expect(wrapper).toHaveAttribute("data-intent", "playing");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(wrapper).toHaveAttribute("data-preview", "ready", { timeout: 15_000 });
  expect(await playerTime(page)).toBeGreaterThanOrEqual(before - 0.5);
  // The notice goes after a few seconds.
  await expect(page.getByTestId("overlay-notice")).toHaveCount(0, { timeout: 10_000 });
  expect(eventsNamed(events, "studio_failure_action")).toEqual([]);
});

test("1440x900: a new version arriving while paused stays paused", async ({ page, baseURL }) => {
  await openReel(page, baseURL!, DESKTOP);
  const nextId = await saveNextVersion();
  const wrapper = page.locator(`[data-version-id="${nextId}"]`);
  await expect(wrapper).toBeVisible({ timeout: 30_000 });
  await expect(wrapper).toHaveAttribute("data-intent", "paused");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});
