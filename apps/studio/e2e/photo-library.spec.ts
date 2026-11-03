import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { DESCRIBE_ANSWER } from "../test-support/ai-script.ts";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The worker's own folder for the derived files (thumbnail and large copy).
const WORKER_PREFIX = `e2e-${crypto.randomUUID()}/`;
const WORKER_ID = `e2e-photos-${crypto.randomUUID()}`;
const SAMPLE = fileURLToPath(new URL("../../../fixtures/photos/sample.jpg", import.meta.url));
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reelId: string;
const leftKeys: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "photo-library");
  reelId = await insertReel(admin, { ownerId: owner.id, name: "library.mp4", status: "received" });
});

test.afterAll(async () => {
  for (const key of leftKeys) await storage.delete(key);
  // The cascade removes the reel, the photos, their jobs, steps and stored files.
  if (owner) await deleteTestUser(admin, owner.id);
  await admin.from("worker_status").delete().eq("worker_id", WORKER_ID);
});

async function openReel(page: Page, baseURL: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
}

// The document never scrolls: measured from the root box, never the window.
async function expectNoPageScroll(page: Page) {
  const sizes = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(sizes.scrollHeight).toBeLessThanOrEqual(sizes.clientHeight);
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

interface PhotoRecord {
  id: string;
  status: string;
  bytes: number | null;
  r2_key: string;
  thumbnail_key: string | null;
  large_key: string | null;
}

async function photoRows(): Promise<PhotoRecord[]> {
  const { data, error } = await admin
    .from("photos")
    .select("id, status, bytes, r2_key, thumbnail_key, large_key")
    .eq("owner_id", owner.id);
  if (error) throw new Error(`photos not read: ${error.message}`);
  return data as PhotoRecord[];
}

test("1440x900: upload, described live, opened and deleted, beside the reel", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await openReel(page, baseURL!, DESKTOP);
  const library = page.getByTestId("library-area");
  await expect(library).toBeVisible();
  await expect(page.locator('[data-library="ready"]')).toBeVisible({ timeout: 30_000 });
  // The third column: right of the reel, inside the root box, no page scroll.
  const edit = (await page.getByTestId("edit-area").boundingBox())!;
  const column = (await library.boundingBox())!;
  expect(column.x).toBeGreaterThanOrEqual(edit.x + edit.width);
  await expectInsideRoot(page, library);
  await expectNoPageScroll(page);
  await expect(library.getByText("No photos yet.")).toBeVisible();

  const plus = page.getByRole("button", { name: "Upload a photo" });
  await expect(plus).toHaveAttribute("data-ready", "true");
  const chooser = page.waitForEvent("filechooser");
  await plus.click();
  await (await chooser).setFiles(SAMPLE);

  const badge = library.getByTestId("photo-status");
  await expect(badge).toHaveText("describing", { timeout: 30_000 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const sampleBytes = (await stat(SAMPLE)).size;
  const [photo] = await photoRows();
  expect(photo).toMatchObject({ status: "describing", bytes: sampleBytes });
  leftKeys.push(photo!.r2_key);
  expect(photo!.r2_key.endsWith(`library/${photo!.id}/original.jpg`)).toBe(true);
  expect(await storage.head(photo!.r2_key)).toMatchObject({ bytes: sampleBytes });
  const original = await admin
    .from("stored_files")
    .select("kind, step, bytes")
    .eq("photo_id", photo!.id);
  expect(original.data).toEqual([{ kind: "kept", step: "upload", bytes: sampleBytes }]);

  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: WORKER_PREFIX,
    WORKER_ID,
    E2E_MOCK_AI_SCRIPT: DESCRIBE_ANSWER,
  });
  expect(worker.code, worker.output).toBe(0);

  // Live, without a reload.
  await expect(badge).toHaveText("ready", { timeout: 15_000 });
  await expect(library.locator("img")).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );

  const [described] = await photoRows();
  leftKeys.push(described!.thumbnail_key!, described!.large_key!);
  expect(described!.thumbnail_key).toBe(`${WORKER_PREFIX}library/${photo!.id}/thumbnail.jpg`);
  expect(described!.large_key).toBe(`${WORKER_PREFIX}library/${photo!.id}/large.jpg`);

  const steps = await admin
    .from("steps")
    .select("name, status, reel_id, ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_model")
    .eq("photo_id", photo!.id)
    .order("started_at");
  expect(steps.data).toEqual([
    expect.objectContaining({ name: "photo_images", status: "done", reel_id: null }),
    {
      name: "describe_photo",
      status: "done",
      reel_id: null,
      ai_input_tokens: 1200,
      ai_output_tokens: 80,
      ai_cost_usd: 0.004,
      ai_model: "claude-opus-5-5",
    },
  ]);
  const derived = await admin
    .from("stored_files")
    .select("r2_key, kind, step")
    .eq("photo_id", photo!.id)
    .eq("kind", "rebuildable")
    .order("r2_key");
  expect(derived.data).toEqual([
    { r2_key: described!.large_key, kind: "rebuildable", step: "photo_images" },
    { r2_key: described!.thumbnail_key, kind: "rebuildable", step: "photo_images" },
  ]);

  // The dialog: the scripted description and tags.
  await library.getByRole("button", { name: /sample\.jpg/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("photo-description")).toHaveText(
    "A colourful test pattern with bars and a moving circle.",
  );
  await expect(dialog.getByTestId("photo-tag")).toHaveText([
    "test pattern",
    "colour bars",
    "abstract",
  ]);
  await expect(dialog.getByRole("img")).toBeVisible();

  await dialog.getByRole("button", { name: "Delete photo" }).click();
  await dialog.getByRole("button", { name: "Yes, delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(library.getByTestId("photo-status")).toHaveCount(0);
  await expect(library.getByText("No photos yet.")).toBeVisible();
  expect(await photoRows()).toEqual([]);
  for (const key of [photo!.r2_key, described!.thumbnail_key!, described!.large_key!]) {
    expect(await storage.head(key)).toBeNull();
  }
});

test("390x844: the Library tab beside Edit and Versions", async ({ page, baseURL }) => {
  await openReel(page, baseURL!, PHONE);
  const tabs = page.getByRole("tablist", { name: "Reel" });
  await expect(tabs.getByRole("tab")).toHaveText(["Edit", "Versions", "Library"]);
  await expect(page.getByTestId("library-area")).toBeHidden();

  await tabs.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByTestId("library-area")).toBeVisible();
  await expect(page.getByTestId("edit-area")).toBeHidden();
  await expectInsideRoot(page, page.getByRole("button", { name: "Upload a photo" }));
  await expectNoPageScroll(page);
});
