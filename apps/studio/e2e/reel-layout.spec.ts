import { readFile } from "node:fs/promises";
import {
  type Edit,
  ISSEBYA_PRESET,
  parseEdit,
  resolveTimeline,
  transcriptSchema,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const TRANSCRIPT = new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const EXTRA_VERSIONS = 12;
const EXTRA_STEPS = 40;
const EXTRA_JOBS = 8;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
const extraKeys: string[] = [];

test.describe.configure({ mode: "serial" });

async function fixtureTranscript() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  return transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
}

// The current version's edit, as the storage double holds it.
async function currentEdit(): Promise<Edit> {
  const { data, error } = await admin
    .from("reels")
    .select("current_version:versions!reels_current_version_fkey(r2_key)")
    .eq("id", reel!.reelId)
    .single<{ current_version: { r2_key: string } }>();
  if (error || !data) throw new Error(`current version not read: ${error?.message}`);
  const stored = await storage.get(data.current_version.r2_key);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    await fixtureTranscript(),
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  return parsed.edit;
}

async function versionRows(): Promise<{ id: string; number: number }[]> {
  const { data, error } = await admin
    .from("versions")
    .select("id, number")
    .eq("reel_id", reel!.reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  return data as { id: string; number: number }[];
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "reel-layout");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });

  // 14 versions in all: long enough that the list must scroll in its area.
  const edit = await currentEdit();
  for (let n = 0; n < EXTRA_VERSIONS; n += 1) {
    const saved = await saveTestVersion({
      admin,
      storage,
      prefix: CACHE_PREFIX,
      reelId: reel.reelId,
      edit,
      changeSummary: `layout version ${n + 3}`,
    });
    extraKeys.push(saved.key);
  }

  // Finished jobs (never claimable) and a long step log.
  const jobs = await admin
    .from("jobs")
    .insert(
      Array.from({ length: EXTRA_JOBS }, () => ({
        reel_id: reel!.reelId,
        owner_id: owner.id,
        status: "done",
      })),
    )
    .select("id");
  if (jobs.error || !jobs.data) throw new Error(`jobs not inserted: ${jobs.error?.message}`);
  const jobId = (jobs.data[0] as { id: string }).id;
  const steps = await admin.from("steps").insert(
    Array.from({ length: EXTRA_STEPS }, (_, n) => ({
      job_id: jobId,
      reel_id: reel!.reelId,
      owner_id: owner.id,
      name: `layout_step_${n}`,
      status: "done",
      summary: `layout step ${n} done, 1 second`,
    })),
  );
  if (steps.error) throw new Error(`steps not inserted: ${steps.error.message}`);
});

test.afterAll(async () => {
  for (const key of [...(reel?.keys ?? []), ...extraKeys]) await storage.delete(key);
  // The cascade removes the reel, its jobs, steps, versions and stored files.
  if (owner) await deleteTestUser(admin, owner.id);
});

async function openReel(page: Page, baseURL: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await routePreviewCdn(page);
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  // The first open compiles the page, the builder and harfbuzzjs under `next dev`.
  await expect(page.locator('[data-preview="ready"]')).toBeVisible({ timeout: 30_000 });
}

// The document never scrolls: measured from the root box, never the window.
async function expectNoPageScroll(page: Page) {
  const sizes = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    bodyScrollHeight: document.body.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(sizes.scrollHeight).toBe(sizes.clientHeight);
  expect(sizes.bodyScrollHeight).toBeLessThanOrEqual(sizes.clientHeight);
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
}

// Inside the root box, so clipping cannot fake a pass.
async function expectInsideRoot(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  const root = await page.evaluate(() => {
    const rect = document.documentElement.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: Math.min(rect.bottom, document.documentElement.clientHeight),
    };
  });
  expect(box.x).toBeGreaterThanOrEqual(root.left);
  expect(box.y).toBeGreaterThanOrEqual(root.top);
  expect(box.x + box.width).toBeLessThanOrEqual(root.right + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(root.bottom + 0.5);
}

// The area scrolls inside its own box, and scrolling it moves no page.
async function expectOwnScroll(page: Page, area: Locator) {
  const own = await area.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(own.scrollHeight).toBeGreaterThan(own.clientHeight);
  expect(own.overflowY).toBe("auto");
  await area.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
}

test("one screen at 1440x900: preview, timeline, change box and the side panel at once", async ({
  page,
  baseURL,
}) => {
  await openReel(page, baseURL!, DESKTOP);
  await expect(page.getByTestId("version-item")).toHaveCount(2 + EXTRA_VERSIONS);
  await expect(page.getByTestId("step-line")).not.toHaveCount(0);

  await expectNoPageScroll(page);
  await expectInsideRoot(page, page.getByRole("button", { name: "Send" }));
  await expectInsideRoot(page, page.getByTestId("export-button"));
  await expectInsideRoot(page, page.getByTestId("tracks"));
  await expect(page.locator("hyperframes-player")).toBeVisible();
  await expect(page.getByTestId("version-item").first()).toBeVisible();
  await expect(page.getByTestId("step-line").first()).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Reel" })).toBeHidden();
  // The photo library is a third column, beside the side panel.
  await expect(page.getByTestId("library-area")).toBeVisible();
  await expectInsideRoot(page, page.getByRole("button", { name: "Upload a photo" }));

  await expectOwnScroll(page, page.getByTestId("versions-area"));
  await expectOwnScroll(page, page.getByTestId("status-area"));
  await expectNoPageScroll(page);
});

test("one screen at 390x844 with tabs Edit, Versions, Status and Library", async ({
  page,
  baseURL,
}) => {
  await openReel(page, baseURL!, PHONE);
  await expectNoPageScroll(page);
  await expectInsideRoot(page, page.getByRole("button", { name: "Send" }));
  await expectInsideRoot(page, page.getByTestId("export-button"));

  const tabs = page.getByRole("tablist", { name: "Reel" });
  await expect(tabs).toBeVisible();
  const tab = (name: string) => tabs.getByRole("tab", { name });
  await expect(tabs.getByRole("tab")).toHaveText(["Edit", "Versions", "Status", "Library"]);
  const field = page.getByLabel("Ask for a change");

  await expect(tab("Edit")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("hyperframes-player")).toBeVisible();
  await expect(page.getByTestId("tracks")).toBeVisible();
  await expect(page.getByTestId("version-item").first()).toBeHidden();
  await expect(field).toBeVisible();

  await tab("Versions").click();
  await expect(tab("Versions")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("version-item").first()).toBeVisible();
  await expect(page.locator("hyperframes-player")).toBeHidden();
  await expect(field).toBeVisible();
  await expectNoPageScroll(page);
  await expectOwnScroll(page, page.getByTestId("versions-area"));

  await tab("Status").click();
  await expect(page.getByTestId("step-line").first()).toBeVisible();
  await expect(page.getByTestId("version-item").first()).toBeHidden();
  await expect(field).toBeVisible();
  await expectNoPageScroll(page);
  await expectOwnScroll(page, page.getByTestId("status-area"));
  await expectInsideRoot(page, page.getByRole("button", { name: "Send" }));

  await tab("Library").click();
  await expect(page.getByTestId("library-area")).toBeVisible();
  await expect(page.getByTestId("step-line").first()).toBeHidden();
  await expectNoPageScroll(page);

  // Arrow keys move between the tabs (WAI-ARIA tabs), wrapping at the end.
  await tab("Library").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab("Edit")).toHaveAttribute("aria-selected", "true");
  await expect(tab("Edit")).toBeFocused();
  await expect(page.locator("hyperframes-player")).toBeVisible();
});

test("tracks: rows at resolveTimeline's times, footage frames, nothing focusable", async ({
  page,
  baseURL,
}) => {
  await openReel(page, baseURL!, DESKTOP);
  const edit = await currentEdit();
  const resolved = resolveTimeline(edit, await fixtureTranscript());
  const tracks = page.getByTestId("tracks");

  const rows = tracks.locator("[data-track]");
  expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-track")))).toEqual([
    "footage",
    "captions",
    "overlays",
    "transitions",
    "sounds",
  ]);
  for (const label of ["Footage", "Captions", "Accents", "Transitions", "Sounds"]) {
    await expect(tracks.getByText(label, { exact: true })).toBeVisible();
  }

  const items = await tracks.getByTestId("track-item").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-item-id")!,
      track: el.closest("[data-track]")!.getAttribute("data-track"),
      start: el.getAttribute("data-start"),
      end: el.getAttribute("data-end"),
    })),
  );
  const trackOf = (id: string) =>
    (["footage", "captions", "overlays", "transitions", "sounds"] as const).find((key) =>
      edit.tracks[key].some((item) => item.id === id),
    );
  const expected = [...resolved.entries()]
    .filter(([id]) => trackOf(id))
    .map(([id, span]) => ({
      id,
      track: trackOf(id)!,
      start: span.start.toFixed(3),
      end: span.end.toFixed(3),
    }));
  expect(items.length).toBeGreaterThan(1);
  expect([...items].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    [...expected].sort((a, b) => a.id.localeCompare(b.id)),
  );

  // The first caption's left edge sits at start / duration of its lane.
  const first = edit.tracks.captions[0]!;
  const lane = (await tracks
    .locator('[data-track="captions"] [data-testid="track-lane"]')
    .boundingBox())!;
  const caption = (await tracks.locator(`[data-item-id="${first.id}"]`).boundingBox())!;
  const at = resolved.get(first.id)!.start / edit.duration;
  expect(Math.abs(caption.x - (lane.x + at * lane.width))).toBeLessThanOrEqual(2);

  // The footage strip's frames come from the preview copy's sprite.
  const frame = tracks.locator('[data-track="footage"] [data-frame-index]').first();
  await expect(frame).toHaveCount(1);
  expect(await frame.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(
    /\/cache\/preview_copies\/[0-9a-f]{64}\/frames\.jpg/,
  );

  // Read only: nothing in it takes focus or a drag.
  await expect(
    tracks.locator(
      "a, button, input, select, textarea, [tabindex], [contenteditable], [draggable=true]",
    ),
  ).toHaveCount(0);
});

test("the playhead follows the player's clock", async ({ page, baseURL }) => {
  await openReel(page, baseURL!, DESKTOP);
  const playhead = page.getByTestId("playhead");
  await expect(playhead).toHaveAttribute("data-seconds", "0.000");
  const startTransform = await playhead.evaluate((el) => (el as HTMLElement).style.transform);

  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(async () => Number(await playhead.getAttribute("data-seconds")), { timeout: 10_000 })
    .toBeGreaterThan(0.5);
  await page.getByRole("button", { name: "Pause" }).click();
  expect(await playhead.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(
    startTransform,
  );
  // The pause reaches the player's frame by message, so a clock tick already
  // in flight can still land: wait for the playhead to settle, then it stays.
  let paused: string | null = null;
  await expect
    .poll(
      async () => {
        const previous = paused;
        paused = await playhead.getAttribute("data-seconds");
        return paused === previous;
      },
      { intervals: [250], timeout: 5_000 },
    )
    .toBe(true);
  await page.waitForTimeout(500);
  expect(await playhead.getAttribute("data-seconds")).toBe(paused);
});

test("Undo and Redo show the previous and next saved version and write nothing", async ({
  page,
  baseURL,
}) => {
  const versions = await versionRows();
  expect(versions).toHaveLength(2 + EXTRA_VERSIONS);
  const before = {
    versions: versions.length,
    jobs: (await admin.from("jobs").select("id").eq("reel_id", reel!.reelId)).data!.length,
  };
  const newest = versions.at(-1)!;
  const item = (number: number) =>
    page.locator(`[data-testid="version-item"][data-version-number="${number}"]`);
  const shown = async (version: { id: string; number: number }) => {
    await expect(item(version.number)).toHaveAttribute("data-selected", "true");
    await expect(
      page.locator(`[data-preview-version="${version.id}"][data-preview="ready"]`),
    ).toBeVisible({ timeout: 30_000 });
  };

  await openReel(page, baseURL!, DESKTOP);
  const undo = page.getByRole("button", { name: "Undo" });
  const redo = page.getByRole("button", { name: "Redo" });
  await expect(item(newest.number)).toHaveAttribute("data-current", "true");
  await shown(newest);
  await expect(redo).toBeDisabled();

  await undo.click();
  const previous = versions.at(-2)!;
  await shown(previous);
  await expect(item(previous.number).getByTestId("version-showing")).toBeVisible();
  await expect(item(newest.number)).toHaveAttribute("data-current", "true");

  await redo.click();
  await shown(newest);
  await expect(redo).toBeDisabled();

  // Back to version 1, one Undo at a time; earlier loads are dropped.
  for (let n = 0; n < versions.length - 1; n += 1) await undo.click({ timeout: 30_000 });
  await shown(versions[0]!);
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();

  // Nothing was written: the same versions and jobs, the newest still current.
  expect((await versionRows()).length).toBe(before.versions);
  expect((await admin.from("jobs").select("id").eq("reel_id", reel!.reelId)).data!.length).toBe(
    before.jobs,
  );
  const { data } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reel!.reelId)
    .single();
  expect(data!.current_version_id).toBe(newest.id);
});
