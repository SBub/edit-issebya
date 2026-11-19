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
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The owner moves, resizes and turns a VISUAL (app_docs/owner-edits.md): the
// same editor as a text, its corner handle scaling the card in proportion (its
// picture's aspect ratio kept), no edge handle, and a rotate handle above it
// that turns it about its centre, snapping upright and to each quarter turn.
// The page on screen follows the pointer at once, and Save makes a version
// with the card's new box and turn and a learning row for it.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const FRAME_WIDTH = 1080;
// Set to a folder to keep screenshots of the editor (never in CI).
const SHOTS = process.env.OWNER_EDIT_SHOTS;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let scriptDir: string;
let page: Page;
// The card as the engine placed it, and where the owner left it.
let engineCard: Card;
let ownerCard: Card;
// The card's turn the owner left, in degrees.
let ownerTurn = 0;

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
  owner = await createTestUser(admin, "owner-edit-visual");
  scriptDir = await mkdtemp(join(tmpdir(), "owner-edit-visual-"));
  // The speech-ten clip: one VISUAL over w0021 to w0027, after the hook.
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    clip: "speech-ten",
    aiScript: await speechTenVisualAnswerScript(scriptDir),
  });
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
    const keys = [...reel.keys, ...((data ?? []) as { r2_key: string }[]).map((row) => row.r2_key)];
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

// The card as the page on screen draws it, in frame pixels (its element's own style).
async function drawn(id: string): Promise<Card> {
  return page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
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

// The card's turn as the page on screen draws it (its element's `rotate`), in
// degrees; 0 when it has none.
async function drawnTurn(id: string): Promise<number> {
  return page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
    .locator(`#${id}`)
    .evaluate((el) => {
      const { rotate, transform } = (el as HTMLElement).style;
      if (transform.includes("rotate")) throw new Error(`a turn in transform: ${transform}`);
      return rotate === "" || rotate === "none" ? 0 : Number.parseFloat(rotate);
    });
}

// The pointer taken from the rotate handle round the card's centre by `degrees`
// (clockwise), in `steps`, calling `each` after every step with the turn so far.
async function turnHandle(
  degrees: number,
  steps: number,
  each?: (sofar: number) => Promise<void>,
): Promise<void> {
  const centre = await centreOf(moveBox(CARD));
  const handle = await centreOf(moveBox(CARD).getByTestId("move-rotate"));
  const radius = Math.hypot(handle.x - centre.x, handle.y - centre.y);
  const start = Math.atan2(handle.y - centre.y, handle.x - centre.x);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const sofar = (degrees * step) / steps;
    const angle = start + (sofar * Math.PI) / 180;
    await page.mouse.move(centre.x + radius * Math.cos(angle), centre.y + radius * Math.sin(angle));
    if (each) await each(sofar);
  }
}

async function screenScale(): Promise<number> {
  const frame = (await page.getByTestId("preview-frame").boundingBox())!;
  return frame.width / FRAME_WIDTH;
}

async function centreOf(locator: ReturnType<typeof moveBox>) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function swapping(): Promise<string | null> {
  return page.locator("[data-page]").first().getAttribute("data-page");
}

async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
}

// The card's id in the version (`visual-1`).
const CARD = "visual-1";

test("a VISUAL picked from the list is selected with its kind and a corner handle, and no edge handle", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await ready();
  await page.getByTestId("edit-toggle").click();
  await expect(page.getByTestId("move-layer")).toBeVisible();
  const pick = page.getByTestId("move-pick");
  await expect(pick.locator("option")).toContainText(["Visual: a phone on a desk"]);
  await pick.selectOption(CARD);
  const box = moveBox(CARD);
  await expect(box).toHaveAttribute("data-selected", "true");
  await expect(box).toHaveAttribute("data-component", "VISUAL");
  await expect(box.getByTestId("move-kind")).toHaveText("Visual");
  await expect(box.getByTestId("move-handle")).toBeVisible();
  await expect(box.getByTestId("move-edge")).toHaveCount(0);
  engineCard = await drawn(CARD);
  await shot("visual-1-selected-with-corner-handle.png");
});

test("dragging the VISUAL moves it at once: on the pointer during the drag, at the drop straight after, and nothing moves when the draft swaps in", async () => {
  const scale = await screenScale();
  const from = await centreOf(moveBox(CARD));
  const dx = 120;
  const dy = -200;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(from.x + ((dx * step) / 6) * scale, from.y + ((dy * step) / 6) * scale);
    const at = await drawn(CARD);
    expect(Math.abs(at.x - (engineCard.x + (dx * step) / 6))).toBeLessThan(2);
    expect(Math.abs(at.y - (engineCard.y + (dy * step) / 6))).toBeLessThan(2);
    expect(at.width).toBe(engineCard.width);
  }
  await page.mouse.up();
  const dropped = await drawn(CARD);
  expect(await swapping()).toBe("swapping");
  expect(Math.abs(dropped.x - (engineCard.x + dx))).toBeLessThan(1.5);
  expect(Math.abs(dropped.y - (engineCard.y + dy))).toBeLessThan(1.5);
  await ready();
  const swapped = await drawn(CARD);
  expect(swapped).toEqual(dropped);
  await shot("visual-2-moved.png");
});

test("the corner handle scales the VISUAL about its corner, keeping its picture's aspect ratio", async () => {
  const before = await drawn(CARD);
  const scale = await screenScale();
  const handle = await centreOf(moveBox(CARD).getByTestId("move-handle"));
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  // In by a quarter of its width.
  await page.mouse.move(handle.x - before.width * 0.25 * scale, handle.y, { steps: 4 });
  const held = await drawn(CARD);
  expect(Math.abs(held.width - before.width * 0.75)).toBeLessThan(2);
  expect(Math.abs(held.height / held.width - before.height / before.width)).toBeLessThan(0.01);
  await page.mouse.up();
  const dropped = await drawn(CARD);
  expect(await swapping()).toBe("swapping");
  await ready();
  ownerCard = await drawn(CARD);
  expect(ownerCard).toEqual(dropped);
  expect(ownerCard.x).toBe(before.x);
  expect(ownerCard.y).toBe(before.y);
  expect(Math.abs(ownerCard.width - before.width * 0.75)).toBeLessThan(2);
  expect(Math.abs(ownerCard.height / ownerCard.width - before.height / before.width)).toBeLessThan(
    0.01,
  );
  // The editor's box follows the card.
  await expect(moveBox(CARD).getByTestId("move-handle")).toBeVisible();
  await shot("visual-3-resized.png");
});

test("a dragged VISUAL snaps to the frame's centre lines with the guides", async () => {
  const before = await drawn(CARD);
  const scale = await screenScale();
  const dx = 540 + 4 - (before.x + before.width / 2);
  const dy = 960 - 4 - (before.y + before.height / 2);
  const from = await centreOf(moveBox(CARD));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx * scale, from.y + dy * scale, { steps: 6 });
  await expect(page.locator('[data-testid="move-guide"][data-axis="vertical"]')).toBeVisible();
  await expect(page.locator('[data-testid="move-guide"][data-axis="horizontal"]')).toBeVisible();
  const held = await drawn(CARD);
  expect(Math.abs(held.x + held.width / 2 - 540)).toBeLessThan(1);
  expect(Math.abs(held.y + held.height / 2 - 960)).toBeLessThan(1);
  await page.mouse.up();
  await ready();
  const at = await drawn(CARD);
  expect(Math.abs(at.x + at.width / 2 - 540)).toBeLessThan(1);
  expect(Math.abs(at.y + at.height / 2 - 960)).toBeLessThan(1);
  ownerCard = at;
  await shot("visual-4-centred.png");
});

test("the rotate handle turns the VISUAL at once: on the pointer during the drag, at the drop straight after, and nothing moves when the draft swaps in", async () => {
  const box = moveBox(CARD);
  await expect(box.getByTestId("move-rotate")).toBeVisible();
  // A text has no rotate handle.
  await expect(page.locator('[data-testid="move-rotate"]')).toHaveCount(1);
  const before = await drawn(CARD);
  expect(await drawnTurn(CARD)).toBe(0);
  await turnHandle(-30, 6, async (sofar) => {
    // Past the 4 degrees around upright the card is on the pointer, in whole degrees.
    if (Math.abs(sofar) <= 5) return;
    expect(Math.abs((await drawnTurn(CARD)) - sofar)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("move-angle")).toHaveText(`${Math.round(sofar)}°`);
  });
  await expect(page.getByTestId("move-angle")).not.toHaveAttribute("data-snapped", "true");
  await page.mouse.up();
  const dropped = await drawnTurn(CARD);
  expect(await swapping()).toBe("swapping");
  expect(Math.abs(dropped + 30)).toBeLessThanOrEqual(1);
  await ready();
  expect(await drawnTurn(CARD)).toBe(dropped);
  // Its box is where it was: it turns about its centre.
  expect(await drawn(CARD)).toEqual(before);
  await expect(box).toHaveAttribute("data-rotation", String(dropped));
  ownerTurn = dropped;
  await shot("visual-5-turned.png");
});

test("a turning VISUAL snaps to a quarter turn and back upright, with its angle and guides as the hint", async () => {
  const guides = page.getByTestId("move-turn-guide");
  // From -30: 117 degrees round is 87, near a quarter turn.
  await turnHandle(117, 8);
  await expect(page.getByTestId("move-angle")).toHaveText("90°");
  await expect(page.getByTestId("move-angle")).toHaveAttribute("data-snapped", "true");
  await expect(guides).toHaveCount(2);
  expect(await drawnTurn(CARD)).toBe(90);
  await shot("visual-6-snapped-quarter-turn.png");
  await page.mouse.up();
  await ready();
  expect(await drawnTurn(CARD)).toBe(90);
  await expect(guides).toHaveCount(0);
  // Held 6 degrees past a quarter turn it does not snap; 3 back from upright it does.
  await turnHandle(6, 2);
  await expect(page.getByTestId("move-angle")).toHaveText("96°");
  await expect(page.getByTestId("move-angle")).not.toHaveAttribute("data-snapped", "true");
  await expect(guides).toHaveCount(0);
  await page.mouse.up();
  await ready();
  await turnHandle(-93, 6);
  await expect(page.getByTestId("move-angle")).toHaveText("0°");
  await expect(page.getByTestId("move-angle")).toHaveAttribute("data-snapped", "true");
  await expect(guides).toHaveCount(2);
  expect(await drawnTurn(CARD)).toBe(0);
  await shot("visual-7-snapped-upright.png");
  // On to a quarter turn again, and dropped there.
  await page.mouse.up();
  await ready();
  await turnHandle(88, 6);
  await expect(page.getByTestId("move-angle")).toHaveAttribute("data-snapped", "true");
  await page.mouse.up();
  expect(await drawnTurn(CARD)).toBe(90);
  await ready();
  expect(await drawnTurn(CARD)).toBe(90);
  ownerTurn = 90;
  ownerCard = await drawn(CARD);
});

test("Save makes a new version with the VISUAL's new box, and a learning row for it", async () => {
  await page.getByTestId("move-save").click();
  await expect(page.getByTestId("move-status")).toHaveText("Saving your changes");
  const jobs = async () => {
    const { data } = await admin
      .from("jobs")
      .select("owner_edit")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "owner_edit");
    return (data ?? []) as { owner_edit: { moves: unknown[] } }[];
  };
  await expect.poll(async () => (await jobs()).length).toBe(1);
  expect((await jobs())[0]!.owner_edit.moves).toEqual([
    {
      id: CARD,
      kind: "box",
      x: ownerCard.x,
      y: ownerCard.y,
      width: ownerCard.width,
      rotation: ownerTurn,
    },
  ]);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, edited_from_id")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as { id: string; edited_from_id: string | null };
  expect(saved.edited_from_id).not.toBeNull();
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  await expect(page.getByTestId("move-layer")).toHaveCount(0);
  expect(await drawn(CARD)).toEqual(ownerCard);
  expect(await drawnTurn(CARD)).toBe(ownerTurn);

  const { data: rows } = await admin
    .from("owner_moves")
    .select(
      "item, component, engine_box, owner_box, moved, resized, rotated, engine_rotation, owner_rotation, wrap_width",
    )
    .eq("reel_id", reel!.reelId);
  expect(rows).toEqual([
    {
      item: CARD,
      component: "VISUAL",
      engine_box: { ...engineCard, size: null },
      owner_box: { ...ownerCard, size: null },
      moved: true,
      resized: true,
      rotated: true,
      engine_rotation: 0,
      owner_rotation: ownerTurn,
      wrap_width: null,
    },
  ]);
});

test("a VISUAL dragged into a corner past the safe zone and the frame's edge stays there, and Save keeps it there", async () => {
  await page.getByTestId("edit-toggle").click();
  await expect(page.getByTestId("move-layer")).toBeVisible();
  await page.getByTestId("move-pick").selectOption(CARD);
  await ready();
  const before = await drawn(CARD);
  const scale = await screenScale();
  // The card's centre onto the frame's right edge, low over the platform
  // buttons' notch: half of it past the frame, all of it past the safe zone.
  const dx = FRAME_WIDTH - (before.x + before.width / 2);
  const dy = 1700 - (before.y + before.height / 2);
  const from = await centreOf(moveBox(CARD));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx * scale, from.y + dy * scale, { steps: 8 });
  await page.mouse.up();
  await ready();
  const corner = await drawn(CARD);
  expect(Math.abs(corner.x + corner.width / 2 - FRAME_WIDTH)).toBeLessThan(2);
  expect(Math.abs(corner.y + corner.height / 2 - 1700)).toBeLessThan(2);
  expect(corner.width).toBe(before.width);
  await shot("visual-8-past-the-safe-zone.png");

  await page.getByTestId("move-save").click();
  await expect(page.getByTestId("move-status")).toHaveText("Saving your changes");
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);
  const { data: versions } = await admin
    .from("versions")
    .select("id, number")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as { id: string };
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  expect(await drawn(CARD)).toEqual(corner);
  const { data: rows } = await admin
    .from("owner_moves")
    .select("owner_box, moved")
    .eq("version_id", saved.id);
  expect(rows).toEqual([{ owner_box: { ...corner, size: null }, moved: true }]);
});
