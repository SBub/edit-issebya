import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA_PRESET,
  SAFE_ZONE,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { placedQuestion } from "../test-support/transitions.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The owner moves, resizes and re-wraps a caption block in the Edit mode
// (app_docs/owner-edits.md; owner decision 2026-11-19): a sentence's captions
// are one box, like any text. The fixture clip says one sentence; its first
// four words, "this is a short", show as captions (the QUESTION shows the
// rest), so the block is those four captions, each an element of its own.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const FRAME_WIDTH = 1080;
const CAPTIONS = ["cw0001", "cw0002", "cw0003", "cw0004"];
const BLOCK = "block_cw0001";
const TRANSCRIPT = new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url);
// Set to a folder to keep screenshots of the editor (never in CI).
const SHOTS = process.env.OWNER_EDIT_SHOTS;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let page: Page;
let edit: Edit;
let placedVersionId: string;
const extraKeys: string[] = [];
// The block's captions as the engine placed them, and where the owner left them.
let engineCaptions: Drawn[];
let ownerCaptions: Drawn[];

interface Drawn {
  id: string;
  x: number;
  y: number;
  fontSize: number;
  text: string;
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
  owner = await createTestUser(admin, "owner-edit-captions");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  // The committed version placed by the engine with a QUESTION, saved with the
  // engine's record the way the decide step saves it.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const stored = await storage.get(reel.versionKey);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  const placed = await placedQuestion(parsed.edit, transcript);
  edit = placed.edit;
  const saved = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel.reelId,
    edit,
    changeSummary: "captions and a question",
    engineRecord: placed.record,
  });
  placedVersionId = saved.id;
  extraKeys.push(saved.key);
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
      ...extraKeys,
      ...((data ?? []) as { r2_key: string }[]).map((row) => row.r2_key),
    ];
    for (const key of new Set(keys)) await storage.delete(key);
  }
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

// The block's captions as the page on screen draws them: each one's corner
// and size as the builder (or the instant view) wrote them on its element.
async function drawn(): Promise<Drawn[]> {
  return page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
    .locator("#text")
    .evaluate(
      (text, ids) =>
        ids.map((id) => {
          const el = text.querySelector<HTMLElement>(`[id="${id}"]`)!;
          return {
            id,
            x: Number.parseFloat(el.style.left),
            y: Number.parseFloat(el.style.top),
            fontSize: Number.parseFloat(el.style.fontSize),
            text: el.textContent ?? "",
          };
        }),
      CAPTIONS,
    );
}

const linesOf = (captions: readonly Drawn[]) => new Set(captions.map((caption) => caption.y)).size;

async function screenScale(): Promise<number> {
  const frame = (await page.getByTestId("preview-frame").boundingBox())!;
  return frame.width / FRAME_WIDTH;
}

// The editor's box for a component, in frame pixels.
async function boxInFrame(id: string) {
  const frame = (await page.getByTestId("preview-frame").boundingBox())!;
  const box = (await moveBox(id).boundingBox())!;
  const scale = FRAME_WIDTH / frame.width;
  return {
    x: (box.x - frame.x) * scale,
    y: (box.y - frame.y) * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
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

test("a sentence's captions are one block in the Edit mode: picked from the list it is selected as Captions, with a corner handle and four edge handles", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(
    page.locator(`[data-preview-version="${placedVersionId}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId("edit-toggle");
  await expect(toggle).toHaveText("Edit");
  await toggle.click();
  await expect(page.getByTestId("move-layer")).toBeVisible();
  const pick = page.getByTestId("move-pick");
  await expect(pick).toHaveAccessibleName("Text or visual to edit");
  await expect(pick.locator("option")).toContainText([/^Captions: this is a short/]);
  // One line for the block, none for a single caption.
  await expect(pick.locator("option", { hasText: /^Captions:/ })).toHaveCount(1);
  await pick.selectOption(BLOCK);
  const box = moveBox(BLOCK);
  await expect(box).toHaveAttribute("data-selected", "true");
  await expect(box).toHaveAttribute("data-component", "CAPTION");
  await expect(box.getByTestId("move-kind")).toHaveText("Captions");
  await expect(box.getByTestId("move-handle")).toBeVisible();
  await expect(box.getByTestId("move-edge")).toHaveCount(4);
  for (const id of CAPTIONS) await expect(moveBox(id)).toHaveCount(0);
  engineCaptions = await drawn();
  expect(engineCaptions.map((caption) => caption.text)).toEqual(["this", "is", "a", "short"]);
  // The editor's box is the box around the four captions.
  const at = await boxInFrame(BLOCK);
  expect(Math.abs(at.x - Math.min(...engineCaptions.map((caption) => caption.x)))).toBeLessThan(3);
  expect(Math.abs(at.y - Math.min(...engineCaptions.map((caption) => caption.y)))).toBeLessThan(3);
  await shot("captions-1-selected.png");
});

test("dragging the block moves every caption of the sentence at once, and the rebuilt draft swaps in with nothing moving", async () => {
  const before = await drawn();
  const scale = await screenScale();
  const box = await boxInFrame(BLOCK);
  const centre = box.y + box.height / 2;
  // Up or down by 160, whichever keeps the block inside the safe zone and its
  // centre off the frame's horizontal centre line (no snap on the way).
  const { top, bottom } = SAFE_ZONE.box;
  const clear = (dy: number) =>
    box.y + dy >= top + 5 &&
    box.y + box.height + dy <= bottom - 5 &&
    Math.min(Math.abs(centre - 960), Math.abs(centre + dy - 960)) > 60 &&
    Math.sign(centre - 960) === Math.sign(centre + dy - 960);
  const dy = clear(-160) ? -160 : 160;
  expect(clear(dy)).toBe(true);
  const from = await centreOf(moveBox(BLOCK));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(from.x, from.y + ((dy * step) / 6) * scale);
    const at = await drawn();
    for (const [index, caption] of at.entries()) {
      expect(Math.abs(caption.y - (before[index]!.y + (dy * step) / 6))).toBeLessThan(2);
      expect(Math.abs(caption.x - before[index]!.x)).toBeLessThan(2);
    }
  }
  await page.mouse.up();
  const dropped = await drawn();
  expect(await swapping()).toBe("swapping");
  for (const [index, caption] of dropped.entries()) {
    expect(Math.abs(caption.y - (before[index]!.y + dy))).toBeLessThan(1.5);
  }
  await ready();
  expect(await drawn()).toEqual(dropped);
  // Every caption moved by the same amount: the sentence is one box.
  expect(new Set(dropped.map((caption, index) => caption.y - before[index]!.y)).size).toBe(1);
  expect(dropped.map((caption) => caption.fontSize)).toEqual(
    before.map((caption) => caption.fontSize),
  );
  await expect(moveBox(BLOCK)).toHaveAttribute("data-selected", "true");
  await shot("captions-2-moved.png");
});

test("the corner handle resizes every caption of the block about its corner", async () => {
  const before = await drawn();
  const scale = await screenScale();
  const handle = await centreOf(moveBox(BLOCK).getByTestId("move-handle"));
  const box = (await moveBox(BLOCK).boundingBox())!;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  // In by a fifth of its width.
  await page.mouse.move(handle.x - box.width * 0.2, handle.y, { steps: 4 });
  const held = await drawn();
  for (const caption of held) {
    expect(Math.abs(caption.fontSize - before[0]!.fontSize * 0.8)).toBeLessThan(3 / scale);
  }
  await page.mouse.up();
  await ready();
  const after = await drawn();
  expect(new Set(after.map((caption) => caption.fontSize)).size).toBe(1);
  expect(after[0]!.fontSize).toBeLessThan(before[0]!.fontSize);
  expect(Math.abs(after[0]!.fontSize - held[0]!.fontSize)).toBeLessThanOrEqual(1);
  // The corner stays: the block's left and top edges are where they were.
  expect(Math.min(...after.map((caption) => caption.x))).toBeCloseTo(
    Math.min(...before.map((caption) => caption.x)),
    0,
  );
  expect(Math.min(...after.map((caption) => caption.y))).toBe(
    Math.min(...before.map((caption) => caption.y)),
  );
  expect(linesOf(after)).toBe(linesOf(before));
});

test("the right edge handle sets the captions on more lines while held, at the same size, and the drop keeps them", async () => {
  const before = await drawn();
  const box = (await moveBox(BLOCK).boundingBox())!;
  const edge = await centreOf(moveBox(BLOCK).locator('[data-edge="right"]'));
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  // In by half its width.
  await page.mouse.move(edge.x - box.width * 0.5, edge.y, { steps: 4 });
  const held = await drawn();
  expect(held.map((caption) => caption.fontSize)).toEqual(
    before.map((caption) => caption.fontSize),
  );
  expect(linesOf(held)).toBeGreaterThan(linesOf(before));
  await shot("captions-3-edge-held.png");
  await page.mouse.up();
  const dropped = await drawn();
  expect(await swapping()).toBe("swapping");
  expect(dropped).toEqual(held);
  await ready();
  ownerCaptions = await drawn();
  expect(ownerCaptions).toEqual(held);
  // A whole caption per line piece: the words are the version's.
  expect(ownerCaptions.map((caption) => caption.text)).toEqual(["this", "is", "a", "short"]);
});

test("Save makes a version with the captions where the owner left them, and a CAPTION learning row for the block", async () => {
  await page.getByTestId("move-save").click();
  await expect(page.getByTestId("move-status")).toHaveText("Saving your changes");
  const jobs = async () => {
    const { data } = await admin
      .from("jobs")
      .select("owner_edit")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "owner_edit");
    return (data ?? []) as {
      owner_edit: { moves: { id: string; x: number; y: number; size: number; width?: number }[] };
    }[];
  };
  await expect.poll(async () => (await jobs()).length).toBe(1);
  const { moves } = (await jobs())[0]!.owner_edit;
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({ id: BLOCK, size: ownerCaptions[0]!.fontSize });
  expect(moves[0]!.width).toBeGreaterThan(0);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, edited_from_id")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as { id: string; edited_from_id: string | null };
  expect(saved.edited_from_id).toBe(placedVersionId);
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  await expect(page.getByTestId("move-layer")).toHaveCount(0);
  expect(await drawn()).toEqual(ownerCaptions);
  await expect(page.getByText("Edited by you").first()).toBeVisible();

  const { data: rows } = await admin
    .from("owner_moves")
    .select("item, component, variant, text, engine_box, owner_box, moved, resized, wrap_width")
    .eq("reel_id", reel!.reelId);
  expect(rows).toHaveLength(1);
  const row = rows![0] as {
    engine_box: { x: number; y: number; size: number };
    owner_box: { x: number; y: number; size: number };
    wrap_width: number | null;
  };
  expect(row).toMatchObject({
    item: BLOCK,
    component: "CAPTION",
    variant: "caption/default",
    text: "this is a short",
    moved: true,
    resized: true,
  });
  expect(row.engine_box).toMatchObject({
    y: Math.min(...engineCaptions.map((caption) => caption.y)),
    size: engineCaptions[0]!.fontSize,
  });
  expect(row.owner_box).toMatchObject({
    y: Math.min(...ownerCaptions.map((caption) => caption.y)),
    size: ownerCaptions[0]!.fontSize,
  });
  expect(row.wrap_width).toBeGreaterThan(0);
  await shot("captions-4-saved.png");
});
