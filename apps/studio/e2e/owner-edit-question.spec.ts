import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA_PRESET,
  parseEdit,
  revealShownAt,
  transcriptSchema,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { seekOnRuler } from "../test-support/ruler.ts";
import { placedQuestion, questionOf } from "../test-support/transitions.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The owner moves, resizes and re-wraps a QUESTION (app_docs/owner-edits.md):
// the question builds up word by word, each word an element of its own, so
// the instant view moves those same elements onto the new lines (the page's
// timeline reveals them), and the saved version still builds the question up
// word by word, with its question mark on the last word, at its new place.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const FRAME_WIDTH = 1080;
const ID = "question-1";
const WHOLE = "test clip for the real studio?";
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
// The version with the question, as the engine placed it.
let edit: Edit;
let questionVersionId: string;
const extraKeys: string[] = [];
// The question as the engine placed it, and where the owner left it.
let engineQuestion: Drawn;
let ownerQuestion: Drawn;

interface Drawn {
  x: number;
  y: number;
  fontSize: number;
  // Its lines, each the words on it, as the page on screen sets them.
  lines: string[][];
  // The words shown at the paused moment (their own opacity and the text's).
  shown: string;
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
  owner = await createTestUser(admin, "owner-edit-question");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  // The committed version with a QUESTION placed by the engine, saved with
  // the engine's record the way the decide step saves it.
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
    changeSummary: "a question",
    engineRecord: placed.record,
  });
  questionVersionId = saved.id;
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

// The question as the page on screen draws it: its corner and size as the
// builder (or the instant view) wrote them on its element, its lines of word
// elements, and the words shown now.
async function drawn(): Promise<Drawn> {
  return page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
    .locator(`[id="${ID}"]`)
    .evaluate((el) => {
      const { left, top, fontSize } = (el as HTMLElement).style;
      const lines: string[][] = [[]];
      for (const kid of el.children) {
        if (kid.tagName === "BR") lines.push([]);
        else lines.at(-1)!.push(kid.textContent ?? "");
      }
      const visible = getComputedStyle(el).opacity === "1";
      const shown = visible
        ? [...el.querySelectorAll<HTMLElement>(".q")]
            .filter((word) => getComputedStyle(word).opacity === "1")
            .map((word) => word.textContent)
            .join(" ")
        : "";
      return {
        x: Number.parseFloat(left),
        y: Number.parseFloat(top),
        fontSize: Number.parseFloat(fontSize),
        lines,
        shown,
      };
    });
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

test("a QUESTION picked from the list is selected as a Question, with its corner and edge handles", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(
    page.locator(`[data-preview-version="${questionVersionId}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("edit-toggle").click();
  await expect(page.getByTestId("move-layer")).toBeVisible();
  const pick = page.getByTestId("move-pick");
  await expect(pick.locator("option")).toContainText([/^Question: test clip/]);
  await pick.selectOption(ID);
  const box = moveBox(ID);
  await expect(box).toHaveAttribute("data-selected", "true");
  await expect(box).toHaveAttribute("data-component", "QUESTION");
  await expect(box.getByTestId("move-kind")).toHaveText("Question");
  await expect(box.getByTestId("move-handle")).toBeVisible();
  await expect(box.getByTestId("move-edge")).toHaveCount(4);
  engineQuestion = await drawn();
  // Every word its own element, the mark on the last, some of it shown.
  expect(engineQuestion.lines.flat()).toEqual(WHOLE.split(" "));
  expect(engineQuestion.shown).not.toBe("");
  await shot("question-1-selected.png");
});

test("dragging the question moves it at once, its words still shown as they were", async () => {
  const before = await drawn();
  const scale = await screenScale();
  const from = await centreOf(moveBox(ID));
  // Down, away from the frame's horizontal centre line (no snap on the way).
  const dx = 0;
  const dy = before.y < 700 ? 240 : -240;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(from.x + ((dx * step) / 6) * scale, from.y + ((dy * step) / 6) * scale);
    const at = await drawn();
    expect(Math.abs(at.y - (before.y + (dy * step) / 6))).toBeLessThan(2);
    expect(at.lines).toEqual(before.lines);
    expect(at.shown).toBe(before.shown);
  }
  await page.mouse.up();
  const dropped = await drawn();
  expect(await swapping()).toBe("swapping");
  expect(Math.abs(dropped.y - (before.y + dy))).toBeLessThan(1.5);
  expect(dropped.shown).toBe(before.shown);
  await ready();
  const swapped = await drawn();
  expect([swapped.x, swapped.y]).toEqual([dropped.x, dropped.y]);
  expect(swapped.lines).toEqual(before.lines);
  expect(swapped.shown).toBe(before.shown);
});

test("the corner handle resizes the question about its corner, every word with it", async () => {
  const before = await drawn();
  const scale = await screenScale();
  const handle = await centreOf(moveBox(ID).getByTestId("move-handle"));
  const box = (await moveBox(ID).boundingBox())!;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  // In by a fifth of its width.
  await page.mouse.move(handle.x - box.width * 0.2, handle.y, { steps: 4 });
  const held = await drawn();
  expect(held.fontSize).toBeLessThan(before.fontSize);
  expect(Math.abs(held.fontSize - before.fontSize * 0.8)).toBeLessThan(3 / scale);
  expect(held.shown).toBe(before.shown);
  await page.mouse.up();
  await ready();
  const after = await drawn();
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  expect(Math.abs(after.fontSize - held.fontSize)).toBeLessThanOrEqual(1);
  expect(after.lines.flat()).toEqual(WHOLE.split(" "));
  expect(after.shown).toBe(before.shown);
});

test("the right edge handle sets the question on more lines while held, the same word elements shown, and the drop keeps them", async () => {
  const before = await drawn();
  const box = (await moveBox(ID).boundingBox())!;
  const edge = await centreOf(moveBox(ID).locator('[data-edge="right"]'));
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  // In by half its width.
  await page.mouse.move(edge.x - box.width * 0.5, edge.y, { steps: 4 });
  const held = await drawn();
  expect(held.fontSize).toBe(before.fontSize);
  expect(held.lines.length).toBeGreaterThan(before.lines.length);
  // The same words in the same order, the mark on the last only, each one
  // the page's own element: the reveal still shows what it showed.
  expect(held.lines.flat()).toEqual(WHOLE.split(" "));
  expect(held.shown).toBe(before.shown);
  await shot("question-2-edge-held.png");
  await page.mouse.up();
  const dropped = await drawn();
  expect(await swapping()).toBe("swapping");
  expect(dropped.lines).toEqual(held.lines);
  expect(dropped.shown).toBe(before.shown);
  await ready();
  ownerQuestion = await drawn();
  expect(ownerQuestion.lines).toEqual(held.lines);
  expect([ownerQuestion.x, ownerQuestion.y]).toEqual([before.x, before.y]);
  expect(ownerQuestion.shown).toBe(before.shown);
});

test("Save makes a version with the question moved and re-wrapped, still built up word by word with its mark, and a learning row for it", async () => {
  await page.getByTestId("move-save").click();
  await expect(page.getByTestId("move-status")).toHaveText("Saving your changes");
  const jobs = async () => {
    const { data } = await admin
      .from("jobs")
      .select("owner_edit")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "owner_edit");
    return (data ?? []) as { owner_edit: { moves: { id: string; width?: number }[] } }[];
  };
  await expect.poll(async () => (await jobs()).length).toBe(1);
  const [move] = (await jobs())[0]!.owner_edit.moves;
  expect(move).toMatchObject({ id: ID, x: ownerQuestion.x, y: ownerQuestion.y });
  expect(move!.width).toBeGreaterThan(0);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, edited_from_id")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as { id: string; edited_from_id: string | null };
  expect(saved.edited_from_id).toBe(questionVersionId);
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  await expect(page.getByTestId("move-layer")).toHaveCount(0);
  const at = await drawn();
  expect([at.x, at.y, at.fontSize]).toEqual([
    ownerQuestion.x,
    ownerQuestion.y,
    ownerQuestion.fontSize,
  ]);
  expect(at.lines).toEqual(ownerQuestion.lines);

  // Its words still appear one by one as they are spoken, the mark with the
  // last; the move changed none of its moments.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const { reveal, end } = questionOf(edit, transcript);
  for (const [index, word] of reveal.entries()) {
    const next = reveal[index + 1]?.at ?? end - ISSEBYA_PRESET.caption.outSeconds;
    const t = (word.at + next) / 2;
    await seekOnRuler(page, t);
    const shown = revealShownAt(reveal, t);
    await expect.poll(async () => (await drawn()).shown).toBe(shown);
    expect(shown.includes("?")).toBe(index === reveal.length - 1);
  }
  await shot("question-3-saved-revealed.png");

  const { data: rows } = await admin
    .from("owner_moves")
    .select("item, component, variant, text, engine_box, owner_box, moved, resized, wrap_width")
    .eq("reel_id", reel!.reelId);
  expect(rows).toHaveLength(1);
  const row = rows![0] as {
    engine_box: unknown;
    owner_box: unknown;
    wrap_width: number | null;
  };
  expect(row).toMatchObject({
    item: ID,
    component: "QUESTION",
    variant: "question/word-by-word",
    text: WHOLE,
    moved: true,
    resized: true,
  });
  expect(row.engine_box).toMatchObject({
    x: engineQuestion.x,
    y: engineQuestion.y,
    size: engineQuestion.fontSize,
  });
  expect(row.owner_box).toMatchObject({
    x: ownerQuestion.x,
    y: ownerQuestion.y,
    size: ownerQuestion.fontSize,
  });
  expect(row.wrap_width).toBeGreaterThan(0);
});
