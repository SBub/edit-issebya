import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISSEBYA_PRESET } from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { behindPhotoAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type SeededPhoto, seedReadyPhoto } from "../test-support/photos.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { seekOnRuler } from "../test-support/ruler.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// A change request that puts a library photo behind the speaker: the worker
// makes the span's mask (the mask double: black, no person) in a `cutout`
// step, records it, and saves version 3 naming it; the live preview shows the
// photo exactly over the `left` spot inside the span and not after it.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const REQUEST = "put my test pattern photo behind me on the left";
const INSIDE = 1.3;
// The span ends with w0010 at 2.605 s; the fixture reel lasts 2.69 s.
const AFTER = 2.65;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let photo: SeededPhoto | null = null;
let scriptDir: string;
const written = new Set<string>();

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "behind");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  for (const key of reel.keys) written.add(key);
  photo = await seedReadyPhoto({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  for (const key of photo.keys) written.add(key);
  scriptDir = await mkdtemp(join(tmpdir(), "behind-"));
});

test.afterAll(async () => {
  if (reel) {
    const { data } = await admin.from("versions").select("r2_key").eq("reel_id", reel.reelId);
    for (const row of (data ?? []) as { r2_key: string }[]) written.add(row.r2_key);
    const files = await admin.from("stored_files").select("r2_key").eq("reel_id", reel.reelId);
    for (const row of (files.data ?? []) as { r2_key: string }[]) written.add(row.r2_key);
  }
  for (const key of written) await storage.delete(key);
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  // The cascade removes the reel, its jobs, versions, stored files and the photo.
  if (owner) await deleteTestUser(admin, owner.id);
});

function composition(page: Page) {
  return page.frameLocator("hyperframes-player iframe");
}

// Seeks with a click on the ruler, then waits until every video playing at that
// moment sits there with a frame, and two frames have painted.
async function seekTo(page: Page, seconds: number) {
  await seekOnRuler(page, seconds);
  await expect
    .poll(
      () =>
        composition(page)
          .locator("body")
          .evaluate((body, t) => {
            const videos = [
              ...body.ownerDocument.querySelectorAll<HTMLVideoElement>("video[data-start]"),
            ].filter((video) => {
              const start = Number(video.dataset.start);
              return t >= start && t < start + Number(video.dataset.duration);
            });
            return videos.every((video) => {
              const at = t - Number(video.dataset.start) + Number(video.dataset.mediaStart ?? 0);
              return (
                !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - at) < 0.1
              );
            });
          }, seconds),
      { timeout: 30_000 },
    )
    .toBe(true);
  await composition(page)
    .locator("body")
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
}

// The photo's box in frame pixels (relative to the composition root, scaled
// back by the frame's width), and whether it shows.
function photoState(page: Page) {
  return composition(page)
    .locator("#photo-1")
    .evaluate((img, frameWidth) => {
      const root = img.ownerDocument.getElementById("root")!.getBoundingClientRect();
      const box = img.getBoundingClientRect();
      const scale = root.width / frameWidth;
      const style = getComputedStyle(img);
      return {
        left: Math.round((box.left - root.left) / scale),
        top: Math.round((box.top - root.top) / scale),
        width: Math.round(box.width / scale),
        height: Math.round(box.height / scale),
        shown: style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0",
        src: (img as HTMLImageElement).src,
      };
    }, ISSEBYA_PRESET.frame.width);
}

test("a change puts a library photo behind the speaker, in its spot, from a stored cut-out", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await routePreviewCdn(page);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-preview="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Ask for a change").fill(REQUEST);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("change-pending")).toHaveText(`Pending: ${REQUEST}`);

  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: await behindPhotoAnswerScript(scriptDir, photo!.id, "left"),
  });
  expect(worker.code, worker.output).toBe(0);

  // Version 3 names one mask and the photo.
  const { data: reelRow } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reel!.reelId)
    .single<{ current_version_id: string }>();
  const { data: v3 } = await admin
    .from("versions")
    .select("id, number, inputs")
    .eq("id", reelRow!.current_version_id)
    .single<{
      id: string;
      number: number;
      inputs: { masks?: { step: string; fingerprint: string; file: string }[]; photos?: string[] };
    }>();
  expect(v3!.number).toBe(3);
  expect(v3!.inputs.photos).toEqual([photo!.id]);
  expect(v3!.inputs.masks).toHaveLength(1);
  const [mask] = v3!.inputs.masks!;
  const maskKey = `${CACHE_PREFIX}cache/cutout/${mask!.fingerprint}/mask.mp4`;
  written.add(maskKey);

  // The change job ran the cut-out, then saved; the mask is recorded.
  const { data: job } = await admin
    .from("jobs")
    .select("id")
    .eq("reel_id", reel!.reelId)
    .eq("kind", "change")
    .single<{ id: string }>();
  const { data: steps } = await admin
    .from("steps")
    .select("name, status, summary")
    .eq("job_id", job!.id)
    .order("started_at");
  expect(steps!.map((step) => [step.name, step.status])).toEqual([
    ["decide", "done"],
    // The footage's background map, made by the process job: reused.
    ["backgrounds", "skipped"],
    ["cutout", "done"],
  ]);
  expect(steps!.find((step) => step.name === "cutout")!.summary).toMatch(
    /^1 cut-out made, 0 reused, 2\.\d s masked, /,
  );
  const { data: stored } = await admin
    .from("stored_files")
    .select("kind, step")
    .eq("reel_id", reel!.reelId)
    .eq("r2_key", maskKey);
  expect(stored).toEqual([{ kind: "rebuildable", step: "cutout" }]);

  // The preview of version 3: the photo over the left spot inside the span.
  await expect(
    page.locator(`[data-preview-version="${v3!.id}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });
  await seekTo(page, INSIDE);
  const spot = ISSEBYA_PRESET.behind.spots.left;
  const inside = await photoState(page);
  expect(inside).toMatchObject({ shown: true });
  expect(inside.src).toContain(`library/${photo!.id}/large.jpg`);
  for (const [actual, expected] of [
    [inside.left, spot.left],
    [inside.top, spot.top],
    [inside.width, spot.right - spot.left],
    [inside.height, spot.bottom - spot.top],
  ] as const) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
  }
  // The cut-out's mask videos play from the signed mask.
  await expect(composition(page).locator('video[src*="/cache/cutout/"]')).toHaveCount(2);

  await seekTo(page, AFTER);
  expect((await photoState(page)).shown).toBe(false);

  // The tracks timeline's Behind row shows the one item.
  const behindRow = page.getByTestId("tracks").locator('[data-track="behind"]');
  await expect(behindRow.getByTestId("track-item")).toHaveCount(1);
  await expect(behindRow.getByTestId("track-item")).toHaveText("photo left");
});
