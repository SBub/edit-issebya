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
import { dropFiles, fileTransfer } from "./drop.ts";

// The worker's own folder for the derived files (thumbnail and large copy).
const WORKER_PREFIX = `e2e-${crypto.randomUUID()}/`;
const WORKER_ID = `e2e-photos-${crypto.randomUUID()}`;
// The line under the library's heading (libraryIntro in src/lib/photos.ts).
const INTRO_EMPTY =
  "Add photos of your work, places or products. When you talk about them, they can appear behind you in your reels.";
const INTRO_WITH_PHOTOS =
  "Photos you add here can appear in your reels, placed behind you when they fit what you're saying";
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

// A ready tile: its image and nothing else (no badge, no text under it).
async function expectOnlyThumbnail(tile: Locator) {
  await expect(tile).toBeVisible();
  await expect(tile.locator("img")).toHaveCount(1);
  await expect(tile.getByTestId("photo-status")).toHaveCount(0);
  await expect(tile.getByTestId("tile-meta")).toHaveCount(0);
  await expect(tile).toHaveText("");
}

// The photo dialog's header: the cross (Close) at the top right, an icon with no
// text, and the bin (Delete photo) directly left of it on the same row. They are
// the dialog's only buttons, so nothing is left at the bottom right.
async function expectDialogHeader(dialog: Locator) {
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const remove = dialog.getByRole("button", { name: "Delete photo", exact: true });
  await expect(dialog.getByRole("button")).toHaveCount(2);
  for (const icon of [close, remove]) {
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText("");
    await expect(icon.locator("svg")).toHaveCount(1);
    const box = (await icon.boundingBox())!;
    expect(Math.round(box.width)).toBe(40);
    expect(Math.round(box.height)).toBe(40);
  }
  await expect(close).toHaveAttribute("title", "Close");
  await expect(remove).toHaveAttribute("title", "Delete photo");
  const frame = (await dialog.boundingBox())!;
  const closeBox = (await close.boundingBox())!;
  expect(frame.x + frame.width - (closeBox.x + closeBox.width)).toBeLessThanOrEqual(24);
  expect(closeBox.y - frame.y).toBeLessThanOrEqual(28);
  await expectLeftOfClose(dialog, remove);
}

// Directly left of Close, on the same row.
async function expectLeftOfClose(dialog: Locator, locator: Locator) {
  const close = (await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox())!;
  const box = (await locator.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(close.x + 0.5);
  expect(close.x - (box.x + box.width)).toBeLessThanOrEqual(12);
  expect(Math.abs(box.y + box.height / 2 - (close.y + close.height / 2))).toBeLessThanOrEqual(2);
}

// Inside the dialog's box, so the header does not overflow it.
async function expectInsideBox(dialog: Locator, locator: Locator) {
  const frame = (await dialog.boundingBox())!;
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(frame.x - 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
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
  // The heading names the library; the line under it invites the first photo,
  // and is the only line: no "No photos yet." above the add tile.
  await expect(library.getByRole("heading", { level: 2 })).toHaveText("Your library");
  await expect(page.getByRole("region", { name: "Your library" })).toBeVisible();
  const intro = library.getByTestId("library-intro");
  await expect(intro).toHaveText(INTRO_EMPTY);
  await expect(library.getByText("No photos yet.")).toHaveCount(0);

  // No round button in the header: the one upload button is the grid's first
  // tile, dashed, and with no photo the only one.
  await expect(page.getByRole("button", { name: "Upload a photo" })).toHaveCount(1);
  await expect(library.locator("#library-heading").locator("..").getByRole("button")).toHaveCount(
    0,
  );
  const grid = library.getByRole("list", { name: "Photos" });
  await expect(grid.getByRole("listitem")).toHaveCount(1);
  const plus = grid.getByRole("listitem").first().getByRole("button", { name: "Upload a photo" });
  await expect(plus).toHaveAttribute("data-ready", "true");
  await expect(plus).toContainText("Upload a photo");
  expect(await plus.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
  const tileBox = (await plus.boundingBox())!;
  expect(Math.abs(tileBox.width - tileBox.height)).toBeLessThanOrEqual(1);
  const chooser = page.waitForEvent("filechooser");
  await plus.click();
  await (await chooser).setFiles(SAMPLE);

  const badge = library.getByTestId("photo-status");
  await expect(badge).toHaveText("describing", { timeout: 30_000 });
  // With a photo in the library, the line says what photos do in a reel.
  await expect(intro).toHaveText(INTRO_WITH_PHOTOS);
  // A tile not ready yet keeps its status, in its name too.
  await expect(library.getByRole("button", { name: "sample.jpg, describing" })).toBeVisible();
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

  // Live, without a reload: a ready tile shows only its thumbnail (no badge,
  // no file name, age or size), its file name kept as its accessible name.
  await expect(badge).toHaveCount(0, { timeout: 15_000 });
  await expect(library.locator("img")).toHaveCount(1);
  await expectOnlyThumbnail(library.getByRole("button", { name: "sample.jpg", exact: true }));
  // Photo tiles stay square: only the reel cards take the studio's radius.
  const photoTile = library.getByRole("button", { name: "sample.jpg", exact: true });
  for (const square of [photoTile, photoTile.getByTestId("tile-thumbnail")]) {
    expect(
      await square.evaluate((el) => {
        const style = getComputedStyle(el);
        return [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].join(" ");
      }),
    ).toBe("0px 0px 0px 0px");
  }
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
  await expectDialogHeader(dialog);

  await dialog.getByRole("button", { name: "Delete photo" }).click();
  // The confirmation takes the bin's place in the header, still left of Close.
  const confirm = dialog.getByTestId("photo-delete-confirm");
  await expect(confirm.getByRole("button")).toHaveText(["Cancel", "Yes, delete"]);
  await expectLeftOfClose(dialog, confirm);
  await dialog.getByRole("button", { name: "Yes, delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(library.getByTestId("photo-status")).toHaveCount(0);
  await expect(intro).toHaveText(INTRO_EMPTY);
  await expect(library.getByText("No photos yet.")).toHaveCount(0);
  expect(await photoRows()).toEqual([]);
  for (const key of [photo!.r2_key, described!.thumbnail_key!, described!.large_key!]) {
    expect(await storage.head(key)).toBeNull();
  }
});

test("1440x900: a photo dropped on the section uploads; several files or a non-image upload nothing", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await openReel(page, baseURL!, DESKTOP);
  await expect(page.locator('[data-library="ready"]')).toBeVisible({ timeout: 30_000 });
  const library = page.getByTestId("library-area");
  const zone = page.getByTestId("photo-drop");
  const hint = page.getByTestId("drop-hint");
  await expect(page.getByRole("button", { name: "Upload a photo" })).toHaveAttribute(
    "data-ready",
    "true",
  );
  const one = await fileTransfer(page, [{ name: "sample.jpg", type: "image/jpeg", path: SAMPLE }]);

  // The highlight: on with the drag's enter, kept while it crosses a child
  // (the heading's own enter and leave), off with the zone's leave.
  await expect(zone).toHaveAttribute("data-drop", "idle");
  await expect(hint).toHaveCount(0);
  await zone.dispatchEvent("dragenter", { dataTransfer: one });
  await expect(zone).toHaveAttribute("data-drop", "over");
  await expect(hint).toHaveText("Drop to upload");
  expect(await zone.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed");
  const heading = page.locator("#library-heading");
  await heading.dispatchEvent("dragenter", { dataTransfer: one });
  await heading.dispatchEvent("dragleave", { dataTransfer: one });
  await expect(zone).toHaveAttribute("data-drop", "over");
  await zone.dispatchEvent("dragleave", { dataTransfer: one });
  await expect(zone).toHaveAttribute("data-drop", "idle");
  await expect(hint).toHaveCount(0);

  // Two files: none uploads.
  const two = await fileTransfer(page, [
    { name: "sample.jpg", type: "image/jpeg", path: SAMPLE },
    { name: "second.jpg", type: "image/jpeg", path: SAMPLE },
  ]);
  await dropFiles(zone, two);
  await expect(library.getByRole("alert")).toHaveText("One file at a time, for now.");
  await expect(zone).toHaveAttribute("data-drop", "idle");
  await expect(library.getByTestId("photo-status")).toHaveCount(0);

  // A file the picker would not offer: refused by name.
  const text = await fileTransfer(page, [
    { name: "notes.txt", type: "text/plain", text: "not a photo" },
  ]);
  await dropFiles(zone, text);
  await expect(library.getByRole("alert")).toHaveText(
    "notes.txt is not a JPEG, PNG, HEIC, HEIF or WebP photo.",
  );
  await expect(library.getByTestId("photo-status")).toHaveCount(0);

  // One photo: the same upload as a pick.
  await dropFiles(zone, one);
  const badge = library.getByTestId("photo-status");
  await expect(badge).toHaveText("describing", { timeout: 30_000 });
  await expect(library.getByRole("alert")).toHaveCount(0);
  // Exactly one photo: neither refused drop left a row behind.
  const rows = await photoRows();
  expect(rows).toHaveLength(1);
  const [photo] = rows;
  leftKeys.push(photo!.r2_key);
  expect(photo!.r2_key.endsWith(`library/${photo!.id}/original.jpg`)).toBe(true);

  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: WORKER_PREFIX,
    WORKER_ID,
    E2E_MOCK_AI_SCRIPT: DESCRIBE_ANSWER,
  });
  expect(worker.code, worker.output).toBe(0);
  await expect(badge).toHaveCount(0, { timeout: 15_000 });
  await expectOnlyThumbnail(library.getByRole("button", { name: "sample.jpg", exact: true }));
  const [described] = await photoRows();
  leftKeys.push(described!.thumbnail_key!, described!.large_key!);
});

test("1440x900: a failed photo keeps its status on the tile", async ({ page, baseURL }) => {
  // Written by the admin the way the worker fails a photo (a HEIC it could
  // not read, say): no thumbnail, status `failed`.
  const id = crypto.randomUUID();
  const inserted = await admin.from("photos").insert({
    id,
    owner_id: owner.id,
    r2_key: `${WORKER_PREFIX}library/${id}/original.heic`,
    file_name: "broken.heic",
    content_type: "image/heic",
    status: "failed",
  });
  if (inserted.error) throw new Error(`photo not inserted: ${inserted.error.message}`);
  try {
    await openReel(page, baseURL!, DESKTOP);
    const library = page.getByTestId("library-area");
    await expect(page.locator('[data-library="ready"]')).toBeVisible({ timeout: 30_000 });
    const failed = library.getByRole("button", { name: "broken.heic, failed" });
    await expect(failed.getByTestId("photo-status")).toHaveText("failed");
    await expect(failed.locator("img")).toHaveCount(0);
    await expect(failed.getByTestId("tile-meta")).toHaveCount(0);
    await expect(failed).toHaveText("failed");
    // The ready photo beside it shows only its thumbnail.
    await expectOnlyThumbnail(library.getByRole("button", { name: "sample.jpg", exact: true }));
    // The tile still opens the dialog.
    await failed.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByTestId("photo-dialog-status")).toHaveText("failed");
  } finally {
    await admin.from("photos").delete().eq("id", id);
  }
});

test.describe("on a touch phone", () => {
  test.use({ hasTouch: true });

  test("390x844: the Library tab beside Edit and Versions, its add tile working by tap", async ({
    page,
    baseURL,
  }) => {
    await openReel(page, baseURL!, PHONE);
    const tabs = page.getByRole("tablist", { name: "Reel" });
    await expect(tabs.getByRole("tab")).toHaveText(["Edit", "Versions", "Library"]);
    await expect(page.getByTestId("library-area")).toBeHidden();

    await tabs.getByRole("tab", { name: "Library" }).tap();
    const library = page.getByTestId("library-area");
    await expect(library).toBeVisible();
    await expect(page.getByTestId("edit-area")).toBeHidden();
    await expect(page.locator('[data-library="ready"]')).toBeVisible({ timeout: 30_000 });
    const plus = page.getByRole("button", { name: "Upload a photo" });
    await expectInsideRoot(page, plus);
    await expectNoPageScroll(page);
    // The same dashed tile as on desktop, first in the grid.
    await expect(
      library.getByRole("list", { name: "Photos" }).getByRole("listitem").first(),
    ).toContainText("Upload a photo");
    await expect(plus).toHaveAttribute("data-ready", "true");

    const before = (await photoRows()).length;
    const chooser = page.waitForEvent("filechooser");
    await plus.tap();
    await (await chooser).setFiles(SAMPLE);
    await expect(library.getByRole("button", { name: /^sample\.jpg/ })).toHaveCount(before + 1, {
      timeout: 30_000,
    });
    await expect.poll(async () => (await photoRows()).length, { timeout: 30_000 }).toBe(before + 1);
    for (const row of await photoRows()) {
      if (!leftKeys.includes(row.r2_key)) leftKeys.push(row.r2_key);
    }
    await expectNoPageScroll(page);

    // The dialog's header fits at 390 px: the bin and the cross at its top right,
    // and with the confirmation shown nothing spills out of the dialog.
    await library
      .getByRole("button", { name: /^sample\.jpg/ })
      .first()
      .tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectDialogHeader(dialog);
    await dialog.getByRole("button", { name: "Delete photo" }).tap();
    const confirm = dialog.getByTestId("photo-delete-confirm");
    await expectLeftOfClose(dialog, confirm);
    await expectInsideBox(dialog, confirm);
    await expectInsideBox(dialog, dialog.getByRole("button", { name: "Close", exact: true }));
    await confirm.getByRole("button", { name: "Cancel" }).tap();
    await dialog.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(dialog).toBeHidden();
  });
});
