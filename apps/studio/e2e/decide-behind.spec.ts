import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import {
  answerRoundsScript,
  behindPhotoAnswerScript,
  behindPhotoItem,
  forbidPhotosAnswerScript,
} from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type SeededPhoto, seedReadyPhoto } from "../test-support/photos.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The automatic decide proposes a library photo behind the speaker (version
// 2, from the fresh reel's `process` job); "no photos in this one" removes it
// and switches photos off for the reel (version 3, `reels.no_photos`); a later
// change whose first answer puts the photo back is refused and its retry
// saves version 4 without it, the forbid still in force.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const FORBID = "no photos in this one";
const LATER = "make the title shorter";

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
  owner = await createTestUser(admin, "decide-behind");
  // The photo first: the process job's decide offers the owner's ready library.
  photo = await seedReadyPhoto({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  for (const key of photo.keys) written.add(key);
  scriptDir = await mkdtemp(join(tmpdir(), "decide-behind-"));
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    aiScript: await behindPhotoAnswerScript(scriptDir, photo.id, "top"),
  });
  for (const key of reel.keys) written.add(key);
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

interface VersionRow {
  id: string;
  number: number;
  inputs: { masks?: unknown[]; photos?: string[] };
  rejected_reasons: string[];
  r2_key: string;
}

// The reel's current version and its flags.
async function currentVersion() {
  const { data: reelRow } = await admin
    .from("reels")
    .select("current_version_id, no_photos, no_big_word")
    .eq("id", reel!.reelId)
    .single<{ current_version_id: string; no_photos: boolean; no_big_word: boolean }>();
  const { data: version } = await admin
    .from("versions")
    .select("id, number, inputs, rejected_reasons, r2_key")
    .eq("id", reelRow!.current_version_id)
    .single<VersionRow>();
  const bytes = await storage.get(version!.r2_key);
  const edit = JSON.parse(new TextDecoder().decode(bytes!)) as {
    tracks: { behind?: { kind: string; spot?: string; photo_id?: string }[] };
  };
  return { reel: reelRow!, version: version!, behind: edit.tracks.behind ?? [] };
}

async function sendChange(page: Page, request: string, script: string) {
  await page.getByLabel("Ask for a change").fill(request);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("change-pending")).toHaveText(`Pending: ${request}`);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_AI_SCRIPT: script });
  expect(worker.code, worker.output).toBe(0);
}

async function expectPreviewOf(page: Page, versionId: string) {
  await expect(
    page.locator(`[data-preview-version="${versionId}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });
}

test("the automatic decide proposes a photo; no photos in this one removes it for good", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);

  // Version 2: the process job's decide put the library photo in `top` (the side spots sit under the fallback caption line).
  const v2 = await currentVersion();
  expect(v2.version.number).toBe(2);
  expect(v2.behind).toEqual([expect.objectContaining({ kind: "photo", spot: "top" })]);
  expect(v2.version.inputs.photos).toEqual([photo!.id]);
  expect(v2.version.inputs.masks).toHaveLength(1);
  expect(v2.reel).toMatchObject({ no_photos: false, no_big_word: false });

  await routePreviewCdn(page);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expectPreviewOf(page, v2.version.id);
  const behindRow = page.getByTestId("tracks").locator('[data-track="behind"]');
  await expect(behindRow.getByTestId("track-item")).toHaveText(["photo top"]);

  // Version 3: the photo gone, photos switched off for the reel.
  await sendChange(page, FORBID, await forbidPhotosAnswerScript(scriptDir));
  const v3 = await currentVersion();
  expect(v3.version.number).toBe(3);
  expect(v3.behind).toEqual([]);
  expect(v3.version.inputs.photos).toBeUndefined();
  expect(v3.reel).toMatchObject({ no_photos: true, no_big_word: false });
  await expectPreviewOf(page, v3.version.id);
  await expect(behindRow.getByTestId("track-item")).toHaveCount(0);

  // Version 4: a later change's first answer puts the photo back (refused),
  // its retry leaves it out; the forbid holds.
  await sendChange(
    page,
    LATER,
    await answerRoundsScript(scriptDir, [
      { items: [behindPhotoItem(photo!.id, "top")], changeSummary: "shorter title, photo back" },
      { items: [], changeSummary: "shorter title" },
    ]),
  );
  const v4 = await currentVersion();
  expect(v4.version.number).toBe(4);
  expect(v4.behind).toEqual([]);
  expect(v4.version.rejected_reasons.join("\n")).toContain("photos are switched off for this reel");
  expect(v4.reel).toMatchObject({ no_photos: true, no_big_word: false });
  await expectPreviewOf(page, v4.version.id);
  await expect(behindRow.getByTestId("track-item")).toHaveCount(0);
});
