import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { speechTenVisualAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { type SeededPhoto, seedReadyPhoto } from "../test-support/photos.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// Pictures from the owner's photo library in the editor
// (app_docs/owner-edits.md): a selected VISUAL's picture swapped for a library
// photo, and a new card added at the paused moment over the engine's card, so
// two cards show at once. Save makes a version showing both photos and a
// learning row for each. A font pair change then keeps both photos
// (app_docs/font-pairs.md).

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// Set to a folder to keep screenshots of the editor (never in CI).
const SHOTS = process.env.OWNER_EDIT_SHOTS;
const CARD = "visual-1";
const ADDED = "owner-visual-1";

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let scriptDir: string;
let page: Page;
// Two ready photos (the second the newest) and one still being described.
let older: SeededPhoto;
let newer: SeededPhoto;
let describing: string;
// The engine's card, before the swap.
let engineCard: Card;

interface Card {
  x: number;
  y: number;
  width: number;
  height: number;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "owner-edit-photos");
  scriptDir = await mkdtemp(join(tmpdir(), "owner-edit-photos-"));
  // The speech-ten clip: one VISUAL over w0021 to w0027, after the hook.
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    clip: "speech-ten",
    aiScript: await speechTenVisualAnswerScript(scriptDir),
  });
  older = await seedReadyPhoto({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  newer = await seedReadyPhoto({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  // The newer one a portrait, so the swapped card's shape changes visibly.
  await admin
    .from("photos")
    .update({ width: 900, height: 1200, created_at: new Date(Date.now() + 60_000).toISOString() })
    .eq("id", newer.id);
  // A name of its own, for its tile in the library.
  await admin.from("photos").update({ file_name: "kitchen.jpg" }).eq("id", older.id);
  describing = crypto.randomUUID();
  const { error } = await admin.from("photos").insert({
    id: describing,
    owner_id: owner.id,
    r2_key: `${CACHE_PREFIX}library/${describing}/original.jpg`,
    file_name: "later.jpg",
    content_type: "image/jpeg",
    status: "describing",
  });
  if (error) throw new Error(`describing photo not seeded: ${error.message}`);
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
  await routePreviewCdn(page);
});

test.afterAll(async () => {
  await page?.context().close();
  if (reel) {
    const { data } = await admin.from("versions").select("r2_key").eq("reel_id", reel.reelId);
    const keys = [
      ...reel.keys,
      ...(older?.keys ?? []),
      ...(newer?.keys ?? []),
      ...((data ?? []) as { r2_key: string }[]).map((row) => row.r2_key),
    ];
    for (const key of new Set(keys)) await storage.delete(key);
  }
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  if (owner) await deleteTestUser(admin, owner.id);
});

function moveBox(id: string) {
  return page.locator(`[data-testid="move-box"][data-component-id="${id}"]`);
}

async function ready() {
  await expect(page.locator('[data-preview="ready"][data-page="shown"]')).toBeVisible({
    timeout: 30_000,
  });
}

function shown() {
  return page.frameLocator('hyperframes-player[data-page="shown"] iframe');
}

// The card as the page on screen draws it, in frame pixels (its element's own style).
async function drawn(id: string): Promise<Card> {
  return shown()
    .locator(`#${id}`)
    .evaluate((el) => {
      const { left, top, width, height } = (el as HTMLElement).style;
      return {
        x: Number.parseFloat(left),
        y: Number.parseFloat(top),
        width: Number.parseFloat(width),
        height: Number.parseFloat(height),
      };
    });
}

// The picture the card shows: its `<img>`'s address, and whether it loaded.
async function picture(id: string): Promise<{ src: string; loaded: boolean }> {
  return shown()
    .locator(`#${id} img`)
    .evaluate((el) => {
      const img = el as HTMLImageElement;
      return { src: img.getAttribute("src") ?? "", loaded: img.complete && img.naturalWidth > 0 };
    });
}

async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
}

test("Change picture opens a picker of every ready library photo, newest first", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await ready();
  await page.getByTestId("edit-toggle").click();
  await expect(page.getByTestId("move-layer")).toBeVisible();
  // Nothing selected: a card can be added; no picture to change.
  await expect(page.getByTestId("move-change-picture")).toHaveCount(0);
  await page.getByTestId("move-pick").selectOption(CARD);
  await ready();
  engineCard = await drawn(CARD);
  expect((await picture(CARD)).src).toContain("visual-");
  await expect(page.getByTestId("move-add-picture")).toHaveCount(0);
  await page.getByTestId("move-change-picture").click();
  const picker = page.getByTestId("picture-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("heading")).toHaveText("Change picture");
  const options = picker.getByTestId("picture-option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute("data-photo-id", newer.id);
  await expect(options.nth(1)).toHaveAttribute("data-photo-id", older.id);
  await expect(picker.locator(`[data-photo-id="${describing}"]`)).toHaveCount(0);
  await shot("photos-1-picker-open.png");
});

test("one click swaps the picture: the card keeps its place, at the photo's aspect ratio", async () => {
  await page.getByTestId("picture-picker").locator(`[data-photo-id="${older.id}"]`).click();
  await expect(page.getByTestId("picture-picker")).toHaveCount(0);
  await expect.poll(async () => (await picture(CARD)).src, { timeout: 30_000 }).toContain(older.id);
  await ready();
  await expect.poll(async () => (await picture(CARD)).loaded).toBe(true);
  const swapped = await drawn(CARD);
  expect(Math.abs(swapped.height / swapped.width - 900 / 1200)).toBeLessThan(0.01);
  // Its centre kept.
  expect(
    Math.abs(swapped.x + swapped.width / 2 - (engineCard.x + engineCard.width / 2)),
  ).toBeLessThan(2);
  expect(
    Math.abs(swapped.y + swapped.height / 2 - (engineCard.y + engineCard.height / 2)),
  ).toBeLessThan(2);
  await expect(moveBox(CARD)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("move-save")).toBeEnabled();
  await shot("photos-2-swapped-picture.png");

  // Moved as usual afterwards, the photo kept.
  const frame = (await page.getByTestId("preview-frame").boundingBox())!;
  const scale = frame.width / 1080;
  const box = (await moveBox(CARD).boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60 * scale, from.y - 80 * scale, { steps: 5 });
  await page.mouse.up();
  await ready();
  const moved = await drawn(CARD);
  expect(Math.abs(moved.x - (swapped.x + 60))).toBeLessThan(2);
  expect((await picture(CARD)).src).toContain(older.id);
});

test("Add picture here adds a card at the paused moment, on top of the engine's card, both shown at once", async () => {
  // Deselect: a click on the layer outside every box.
  const layer = (await page.getByTestId("move-layer").boundingBox())!;
  await page.mouse.click(layer.x + layer.width - 4, layer.y + layer.height - 30);
  await expect(page.getByTestId("move-change-picture")).toHaveCount(0);
  const add = page.getByTestId("move-add-picture");
  await expect(add).toBeEnabled();
  await add.click();
  const picker = page.getByTestId("picture-picker");
  await expect(picker.getByRole("heading")).toHaveText("Add a picture here");
  await picker.locator(`[data-photo-id="${newer.id}"]`).click();
  await expect(moveBox(ADDED)).toBeVisible({ timeout: 30_000 });
  await expect(moveBox(ADDED)).toHaveAttribute("data-selected", "true");
  await ready();
  // Both cards on screen at the paused moment, each with its photo.
  await expect(moveBox(CARD)).toBeVisible();
  await expect.poll(async () => (await picture(ADDED)).src).toContain(newer.id);
  await expect.poll(async () => (await picture(ADDED)).loaded).toBe(true);
  expect((await picture(CARD)).src).toContain(older.id);
  const added = await drawn(ADDED);
  expect(Math.abs(added.height / added.width - 1200 / 900)).toBeLessThan(0.01);
  // The added card is drawn on top: last in the page and last in the editor.
  const order = await shown()
    .locator('[id="visual-1"], [id="owner-visual-1"]')
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(order).toEqual([CARD, ADDED]);
  const boxes = await page
    .locator('[data-testid="move-box"][data-component="VISUAL"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-component-id")),
    );
  expect(boxes).toEqual([CARD, ADDED]);
  await shot("photos-3-two-pictures-at-once.png");
});

test("Save makes a version showing both photos, and a learning row for the swap and the added card", async () => {
  await page.getByTestId("move-save").click();
  await expect(page.getByTestId("move-status")).toHaveText("Saving your changes");
  const jobs = async () => {
    const { data } = await admin
      .from("jobs")
      .select("owner_edit")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "owner_edit");
    return (data ?? []) as { owner_edit: { moves: unknown[]; adds: unknown[] } }[];
  };
  await expect.poll(async () => (await jobs()).length).toBe(1);
  const payload = (await jobs())[0]!.owner_edit;
  expect(payload.moves).toEqual([
    expect.objectContaining({ id: CARD, kind: "box", photo_id: older.id }),
  ]);
  expect(payload.adds).toEqual([
    expect.objectContaining({ id: ADDED, photo_id: newer.id, word: expect.any(String) }),
  ]);
  // The browser sends no photo size: the worker reads it from the library.
  expect(JSON.stringify(payload)).not.toContain('"height"');
  const before = { card: await drawn(CARD), added: await drawn(ADDED) };
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, edited_from_id, inputs")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as {
    id: string;
    edited_from_id: string | null;
    inputs: { photos?: string[] };
  };
  expect(saved.edited_from_id).not.toBeNull();
  expect(saved.inputs.photos).toEqual([older.id, newer.id].sort());
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  await expect(page.getByTestId("move-layer")).toHaveCount(0);
  // The saved version draws both cards where the draft had them, each with
  // its photo's large copy signed from the library.
  expect(await drawn(CARD)).toEqual(before.card);
  expect(await drawn(ADDED)).toEqual(before.added);
  await expect.poll(async () => (await picture(CARD)).loaded).toBe(true);
  expect((await picture(CARD)).src).not.toContain("photos/");
  expect((await picture(ADDED)).src).not.toContain("photos/");

  const { data: rows } = await admin
    .from("owner_moves")
    .select("item, component, engine_box, owner_box, added, swapped, photo_id, replaced, context")
    .eq("version_id", saved.id)
    .order("item");
  const byItem = new Map(
    (
      rows as {
        item: string;
        engine_box: unknown;
        added: boolean;
        swapped: boolean;
        photo_id: string | null;
        replaced: string | null;
        context: { words: string; photo: { description: string; tags: string[] } | null };
      }[]
    ).map((row) => [row.item, row]),
  );
  expect(byItem.get(CARD)).toMatchObject({
    added: false,
    swapped: true,
    photo_id: older.id,
    replaced: expect.stringMatching(/^assets\/visuals\/visual-\d\.jpg$/),
    engine_box: { ...engineCard, size: null },
  });
  expect(byItem.get(ADDED)).toMatchObject({
    added: true,
    swapped: false,
    photo_id: newer.id,
    replaced: null,
    engine_box: null,
  });
  for (const row of byItem.values()) {
    expect(row.context.words.length).toBeGreaterThan(0);
    expect(row.context.photo).toEqual({
      description: "A colourful test pattern of vertical bars.",
      tags: ["test pattern", "colour bars", "abstract"],
    });
  }
});

test("choosing another font pair keeps both photos in the new version", async () => {
  const { data: before } = await admin
    .from("versions")
    .select("id, number")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const owners = before!.at(-1) as { id: string; number: number };
  const added = await drawn(ADDED);

  await expect(page.getByTestId("font-pair-classic")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("font-pair-bold").click();
  const relayouts = async () => {
    const { data } = await admin
      .from("jobs")
      .select("status, font_pair")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "relayout");
    return data ?? [];
  };
  await expect.poll(relayouts).toEqual([{ status: "queued", font_pair: "bold" }]);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);
  // The job is done, not failed: no "Could not set the new font".
  expect(await relayouts()).toEqual([{ status: "done", font_pair: "bold" }]);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, parent_id, r2_key, inputs")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as {
    id: string;
    number: number;
    parent_id: string;
    r2_key: string;
    inputs: { photos?: string[] };
  };
  expect(saved).toMatchObject({ number: owners.number + 1, parent_id: owners.id });
  expect(saved.inputs.photos).toEqual([older.id, newer.id].sort());
  const edit = JSON.parse(new TextDecoder().decode((await storage.get(saved.r2_key))!)) as {
    font_pair: string;
    inputs: { photos?: string[] };
    tracks: { behind: { id: string; image?: string; photo?: { id: string } }[] };
  };
  expect(edit.font_pair).toBe("bold");
  expect(edit.inputs.photos).toEqual([older.id, newer.id].sort());
  // The engine's card keeps the photo the owner gave it (no stand-in), and
  // the added card is still there, after it.
  expect(edit.tracks.behind.map((item) => [item.id, item.photo?.id, item.image])).toEqual([
    [CARD, older.id, undefined],
    [ADDED, newer.id, undefined],
  ]);

  // The preview moves to the new version and draws both cards with their
  // photos; the added card is where the owner put it.
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  await expect(page.getByTestId("font-pair-bold")).toHaveAttribute("aria-checked", "true");
  expect(await drawn(ADDED)).toEqual(added);
  // The engine's card at its photo's aspect (the older photo's own).
  const card = await drawn(CARD);
  const { data: photo } = await admin
    .from("photos")
    .select("width, height")
    .eq("id", older.id)
    .single();
  const size = photo as { width: number; height: number };
  expect(Math.abs(card.height - (card.width * size.height) / size.width)).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await picture(CARD)).loaded).toBe(true);
  await expect.poll(async () => (await picture(ADDED)).loaded).toBe(true);
  expect((await picture(CARD)).src).not.toContain("photos/");
  expect((await picture(ADDED)).src).not.toContain("photos/");
  await shot("photos-4-font-pair.png");
});

test("deleting a photo a version shows warns first with the number of versions, and the version then shows a notice", async () => {
  const library = page.getByTestId("photo-drop");
  await library.getByRole("button", { name: "kitchen.jpg", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "kitchen.jpg" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("photo-delete-usage")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Delete photo" }).click();
  // Two versions show it: the owner's saved version and the one laid out
  // from it in the bold pair (the version before them shows the stand-in).
  await expect(dialog.getByTestId("photo-delete-usage")).toHaveText(
    "Used in 2 versions of your reels. They will show a notice instead of the photo, and cannot be exported",
  );
  await expect(dialog.getByTestId("photo-delete-confirm").getByRole("button")).toHaveText([
    "Cancel",
    "Yes, delete",
  ]);
  await shot("photos-5-delete-warning.png");
  // Allowed all the same.
  await dialog.getByRole("button", { name: "Yes, delete" }).click();
  await expect(dialog).toBeHidden();
  const { data } = await admin.from("photos").select("id").eq("id", older.id);
  expect(data).toEqual([]);
  // The version that shows it is unchanged, and its preview names the gap.
  await page.reload();
  await expect(page.getByText("A photo in this version was deleted from the library")).toBeVisible({
    timeout: 30_000,
  });
});
