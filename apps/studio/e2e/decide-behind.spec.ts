import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { speechTenVisualAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// The automatic decide proposes a VISUAL over the speaker's words (version 2,
// from the fresh reel's `process` job), placed as a small corner card in front
// of the speaker, and the preview shows its frame. The decide step reads no
// photo library any more. The owner's requests (no
// photos, and the rest) need the change box, which is removed for now
// (app_docs/change-requests.md).
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
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
  scriptDir = await mkdtemp(join(tmpdir(), "decide-behind-"));
  // The speech-ten clip: its hook holds 0.2 s to 3 s, so the visual's words
  // (w0021 to w0027) come after it.
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    clip: "speech-ten",
    aiScript: await speechTenVisualAnswerScript(scriptDir),
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
  // The cascade removes the reel, its jobs, versions and stored files.
  if (owner) await deleteTestUser(admin, owner.id);
});

interface VersionRow {
  id: string;
  number: number;
  inputs: { masks?: unknown[]; photos?: string[] };
  rejected_reasons: string[];
  change_title: string | null;
  change_summary: string | null;
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
    .select("id, number, inputs, rejected_reasons, change_title, change_summary, r2_key")
    .eq("id", reelRow!.current_version_id)
    .single<VersionRow>();
  const bytes = await storage.get(version!.r2_key);
  const edit = JSON.parse(new TextDecoder().decode(bytes!)) as {
    tracks: {
      behind?: {
        kind: string;
        spot?: string;
        layer?: string;
        box?: { width: number; height: number };
      }[];
    };
  };
  return { reel: reelRow!, version: version!, behind: edit.tracks.behind ?? [] };
}

async function expectPreviewOf(page: Page, versionId: string) {
  await expect(
    page.locator(`[data-preview-version="${versionId}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });
}

test("the automatic decide proposes a visual, and the preview shows its frame", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);

  // Version 2: the process job's decide proposed a visual, and the layout put
  // it as a card over the footage: the full card (360 by 450) or its smaller
  // step (252 by 315), beside the speaker, never over the face.
  const v2 = await currentVersion();
  expect(v2.version.number).toBe(2);
  expect(v2.behind).toEqual([expect.objectContaining({ kind: "visual", layer: "front" })]);
  const [card] = v2.behind;
  expect([
    [360, 450],
    [252, 315],
  ]).toContainEqual([card!.box!.width, card!.box!.height]);
  // No library photo is named by a new version.
  expect(v2.version.inputs.photos ?? []).toEqual([]);
  expect(v2.reel).toMatchObject({ no_photos: false, no_big_word: false });

  await routePreviewCdn(page);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expectPreviewOf(page, v2.version.id);
  const behindRow = page.getByTestId("tracks").locator('[data-track="behind"]');
  await expect(behindRow.getByTestId("track-item")).toHaveText([/visual/]);
});
