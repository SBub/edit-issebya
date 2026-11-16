import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { SHORT_SPEECH_ANSWER } from "../test-support/ai-script.ts";
import {
  createTestUser,
  deleteTestUser,
  signInLink,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The owner's moves (app_docs/owner-edits.md): on the paused preview the owner
// selects a text component, drags it, resizes it by its corner handle and
// presses Save. The worker saves a new version marked "Edited by you"; the
// edited version stays as it was, and going back and Start over never touch
// the owner's version.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// The frame the builder lays out in, and the safe zone's left edge in it.
const FRAME_WIDTH = 1080;
const SAFE_LEFT = 35;
// Set to a folder to keep screenshots of the editor (never in CI).
const SHOTS = process.env.OWNER_EDIT_SHOTS;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
// Version 2 is the committed answer placed by the engine: the hook and one accent.
let reel: ProcessedReel | null = null;
let page: Page;
// Where the engine placed the two texts, and where the owner left them.
let engineHook: Drawn;
let engineAccent: Drawn;
let ownerHook: Drawn;
let ownerAccent: Drawn;
let editedVersionId: string;

interface Drawn {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
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
  owner = await createTestUser(admin, "owner-edit");
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    aiScript: SHORT_SPEECH_ANSWER,
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
    const versions = await versionsOf();
    for (const key of new Set([...reel.keys, ...versions.map((version) => version.r2_key)])) {
      await storage.delete(key);
    }
  }
  if (owner) await deleteTestUser(admin, owner.id);
});

interface VersionRecord {
  id: string;
  number: number;
  parent_id: string | null;
  edited_from_id: string | null;
  restored_from_id: string | null;
  r2_key: string;
}

async function versionsOf(): Promise<VersionRecord[]> {
  const { data, error } = await admin
    .from("versions")
    .select("id, number, parent_id, edited_from_id, restored_from_id, r2_key")
    .eq("reel_id", reel!.reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  return (data ?? []) as VersionRecord[];
}

async function ownerEditJobs() {
  const { data, error } = await admin
    .from("jobs")
    .select("status, owner_edit")
    .eq("reel_id", reel!.reelId)
    .eq("kind", "owner_edit")
    .order("created_at");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return (data ?? []) as {
    status: string;
    owner_edit: { version_id: string; moves: { id: string; x: number; y: number; size: number }[] };
  }[];
}

async function ownerMoves() {
  const { data, error } = await admin
    .from("owner_moves")
    .select(
      "version_id, from_version_id, engine_version_id, item, component, text, engine_box, owner_box, moved, resized, context",
    )
    .eq("reel_id", reel!.reelId)
    .order("item");
  if (error) throw new Error(`owner moves not read: ${error.message}`);
  return data ?? [];
}

async function versionBytes(key: string): Promise<string> {
  return new TextDecoder().decode((await storage.get(key))!);
}

async function runWorker(env: Record<string, string> = {}) {
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, ...env });
  expect(worker.code, worker.output).toBe(0);
}

// The composition on screen (a rebuilt draft is readied behind it first).
function composition() {
  return page.frameLocator('hyperframes-player[data-page="shown"] iframe');
}

function moveBox(id: string) {
  return page.locator(`[data-testid="move-box"][data-component-id="${id}"]`);
}

function versionItem(number: number) {
  return page.locator(`[data-testid="version-item"][data-version-number="${number}"]`);
}

// The preview ready, and the page it was last given on screen (a rebuilt
// draft swapped in).
async function ready() {
  await expect(page.locator('[data-preview="ready"][data-page="shown"]')).toBeVisible({
    timeout: 30_000,
  });
}

// Watches the preview on every animation frame until `stopWatching`: each
// frame where it shows Loading, has no player on screen, a player on screen
// that is not ready or not visible, or a video showing at that moment with no
// decoded frame is a flash.
async function watchForFlashes() {
  await page.evaluate(() => {
    const watch = { frames: 0, flashes: [] as string[], stop: false };
    (window as unknown as { __flashWatch: typeof watch }).__flashWatch = watch;
    const frame = () => {
      if (watch.stop) return;
      watch.frames += 1;
      const reasons: string[] = [];
      const preview = document.querySelector("[data-preview]");
      if (preview?.getAttribute("data-preview") !== "ready") reasons.push("loading");
      const shown = document.querySelector<HTMLElement>('hyperframes-player[data-page="shown"]');
      if (!shown) {
        reasons.push("no player");
      } else {
        const player = shown as HTMLElement & {
          ready?: boolean;
          currentTime?: number;
          iframeElement?: HTMLIFrameElement | null;
        };
        const style = getComputedStyle(shown);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          reasons.push("player hidden");
        }
        if (!player.ready) reasons.push("player not ready");
        const t = player.currentTime ?? 0;
        const videos = player.iframeElement?.contentDocument?.querySelectorAll("video[data-start]");
        for (const video of videos ?? []) {
          const el = video as HTMLVideoElement;
          const start = Number(el.dataset.start);
          const duration = Number(el.dataset.duration);
          if (t >= start && t < start + duration && el.readyState < 2) {
            reasons.push("video frame not decoded");
          }
        }
      }
      if (reasons.length > 0) watch.flashes.push(reasons.join(", "));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function stopWatching(): Promise<{ frames: number; flashes: string[] }> {
  return page.evaluate(() => {
    const watch = (
      window as unknown as { __flashWatch: { frames: number; flashes: string[]; stop: boolean } }
    ).__flashWatch;
    watch.stop = true;
    return { frames: watch.frames, flashes: watch.flashes };
  });
}

// A text as the built page draws it, in frame pixels: its corner and size as
// the builder wrote them on the element (its way in moves it for a moment, so
// the rectangle on screen is not read for them), its width and height from the
// composition's own document, which is the 1080 by 1920 frame.
async function drawn(id: string): Promise<Drawn> {
  return composition()
    .locator(`#${id}`)
    .evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const { left, top, fontSize } = (el as HTMLElement).style;
      return {
        x: Number.parseFloat(left),
        y: Number.parseFloat(top),
        width: rect.width,
        height: rect.height,
        fontSize: Number.parseFloat(fontSize),
      };
    });
}

// The editor's box for a component, in frame pixels, from the preview frame's
// own box (never the window).
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

// Screen pixels per frame pixel.
async function screenScale(): Promise<number> {
  const frame = (await page.getByTestId("preview-frame").boundingBox())!;
  return frame.width / FRAME_WIDTH;
}

// A real drag with the mouse, from a point by a distance in frame pixels.
async function dragBy(from: { x: number; y: number }, frameDx: number, frameDy: number) {
  const scale = await screenScale();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (frameDx * scale) / 2, from.y + (frameDy * scale) / 2, {
    steps: 4,
  });
  await page.mouse.move(from.x + frameDx * scale, from.y + frameDy * scale, { steps: 4 });
  await page.mouse.up();
}

async function centreOf(locator: ReturnType<typeof moveBox>) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
}

test("Move text opens the editor on the paused preview: a text picked from the list is selected, with its kind and a handle", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await ready();
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });

  const toggle = page.getByTestId("move-toggle");
  await expect(toggle).toHaveText("Move text");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("move-layer")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("move-layer")).toBeVisible();
  // The editor works on a paused preview, and nothing is moved yet.
  await expect(page.getByTestId("play-toggle")).toBeDisabled();
  await expect(page.getByTestId("move-save")).toBeDisabled();
  await expect(page.getByTestId("move-cancel")).toBeEnabled();

  // The list holds the reel's text components, by kind: no caption.
  const pick = page.getByTestId("move-pick");
  await expect(pick.locator("option")).toHaveText([
    "Pick a text",
    "Hook: A short test for the real s…",
    /^Accent: /,
  ]);

  // Picking the hook takes the preview to a moment where it shows and selects it.
  await pick.selectOption("hook");
  await expect(moveBox("hook")).toHaveAttribute("data-selected", "true");
  await expect(moveBox("hook")).toHaveAttribute("data-component", "HOOK");
  await expect(moveBox("hook").getByTestId("move-kind")).toHaveText("Hook");
  await expect(moveBox("hook").getByTestId("move-handle")).toBeVisible();
  await expect(page.getByTestId("preview-clock-position")).toHaveText("00:02.267");

  // The box is the text's own box on screen.
  engineHook = await drawn("hook");
  const box = await boxInFrame("hook");
  expect(Math.abs(box.x - engineHook.x)).toBeLessThan(2);
  expect(Math.abs(box.y - engineHook.y)).toBeLessThan(2);
  expect(Math.abs(box.width - engineHook.width)).toBeLessThan(3);
  expect(Math.abs(box.height - engineHook.height)).toBeLessThan(2);
  await shot("1-selected-hook-with-handle.png");
});

test("dragging the selected text moves it for its whole time on screen, and the preview is built again from the draft", async () => {
  await watchForFlashes();
  await dragBy(await centreOf(moveBox("hook")), -100, 300);
  await ready();
  // Half a second more after the swap, then the watch: never a frame without
  // the video and the texts, during the drag or after it.
  await page.waitForTimeout(500);
  const watched = await stopWatching();
  expect(watched.frames).toBeGreaterThan(10);
  expect(watched.flashes).toEqual([]);
  // One player again: the draft's page replaced the version's.
  await expect(page.locator("hyperframes-player")).toHaveCount(1);
  ownerHook = await drawn("hook");
  expect(Math.abs(ownerHook.x - (engineHook.x - 100))).toBeLessThan(1.5);
  expect(Math.abs(ownerHook.y - (engineHook.y + 300))).toBeLessThan(1.5);
  // Moved, not resized.
  expect(ownerHook.fontSize).toBe(engineHook.fontSize);
  expect(Math.abs(ownerHook.width - engineHook.width)).toBeLessThan(1);
  // The box follows the text, still selected, and Save opens.
  await expect(moveBox("hook")).toHaveAttribute("data-selected", "true");
  const box = await boxInFrame("hook");
  expect(Math.abs(box.x - ownerHook.x)).toBeLessThan(2);
  expect(Math.abs(box.y - ownerHook.y)).toBeLessThan(2);
  await expect(page.getByTestId("move-save")).toBeEnabled();
  // One box for its whole time on screen: earlier in the hook's window it is there too.
  await expect(page.getByTestId("preview-clock-position")).toHaveText("00:02.267");
  await shot("2-hook-moved.png");
});

test("a drag past the edge of the safe zone stops at the edge", async () => {
  await dragBy(await centreOf(moveBox("hook")), -2000, 0);
  await ready();
  const at = await drawn("hook");
  expect(Math.abs(at.x - SAFE_LEFT)).toBeLessThan(1.5);
  expect(Math.abs(at.y - ownerHook.y)).toBeLessThan(1.5);
  // Back to where the owner wants it.
  await dragBy(await centreOf(moveBox("hook")), ownerHook.x - at.x, 0);
  await ready();
  const back = await drawn("hook");
  expect(Math.abs(back.x - ownerHook.x)).toBeLessThan(1.5);
  ownerHook = back;
});

test("the corner handle resizes the text, its corner staying where it is", async () => {
  await page.getByTestId("move-pick").selectOption("accent-1");
  await expect(moveBox("accent-1")).toHaveAttribute("data-selected", "true");
  await expect(moveBox("accent-1").getByTestId("move-kind")).toHaveText("Accent");
  engineAccent = await drawn("accent-1");
  expect(engineAccent.fontSize).toBe(110);

  // The handle dragged in by three tenths of the box's width: 110 px to 77 px.
  const handle = moveBox("accent-1").getByTestId("move-handle");
  await dragBy(await centreOf(handle), -engineAccent.width * 0.3, 0);
  await ready();
  ownerAccent = await drawn("accent-1");
  expect(ownerAccent.fontSize).toBe(77);
  expect(Math.abs(ownerAccent.x - engineAccent.x)).toBeLessThan(1.5);
  expect(Math.abs(ownerAccent.y - engineAccent.y)).toBeLessThan(1.5);
  expect(Math.abs(ownerAccent.width - engineAccent.width * 0.7)).toBeLessThan(2);
  expect(Math.abs(ownerAccent.height - 77)).toBeLessThan(1);
  const box = await boxInFrame("accent-1");
  expect(Math.abs(box.width - ownerAccent.width)).toBeLessThan(3);
});

test("Cancel drops the draft: the version shows as it was and nothing is queued", async () => {
  await page.getByTestId("move-cancel").click();
  await expect(page.getByTestId("move-layer")).toHaveCount(0);
  await expect(page.getByTestId("move-toggle")).toHaveAttribute("aria-pressed", "false");
  await ready();
  await expect(page.getByTestId("play-toggle")).toBeEnabled();
  const hook = await drawn("hook");
  expect(Math.abs(hook.x - engineHook.x)).toBeLessThan(1);
  expect(Math.abs(hook.y - engineHook.y)).toBeLessThan(1);
  expect(await ownerEditJobs()).toEqual([]);
  expect((await versionsOf()).map((version) => version.number)).toEqual([1, 2]);
});

test("Save sends the moves, and the worker saves them as a new version marked Edited by you", async () => {
  // The same two edits again, then Save.
  await page.getByTestId("move-toggle").click();
  await page.getByTestId("move-pick").selectOption("hook");
  await expect(moveBox("hook")).toHaveAttribute("data-selected", "true");
  await dragBy(await centreOf(moveBox("hook")), -100, 300);
  await ready();
  await page.getByTestId("move-pick").selectOption("accent-1");
  await expect(moveBox("accent-1")).toHaveAttribute("data-selected", "true");
  await dragBy(
    await centreOf(moveBox("accent-1").getByTestId("move-handle")),
    -engineAccent.width * 0.3,
    0,
  );
  await ready();
  ownerAccent = await drawn("accent-1");
  // Back on the hook's moment, to read where the draft draws it.
  await page.getByTestId("move-pick").selectOption("hook");
  await expect(moveBox("hook")).toHaveAttribute("data-selected", "true");
  ownerHook = await drawn("hook");

  const before = await versionsOf();
  const editedKey = before[1]!.r2_key;
  const editedBytes = await versionBytes(editedKey);

  await page.getByTestId("move-save").click();
  await expect(page.getByTestId("move-status")).toHaveText("Saving your changes");
  await expect(page.getByTestId("move-save")).toBeDisabled();
  await expect.poll(async () => (await ownerEditJobs()).length).toBe(1);
  const [job] = await ownerEditJobs();
  expect(job!.status).toBe("queued");
  expect(job!.owner_edit.version_id).toBe(before[1]!.id);
  expect(job!.owner_edit.moves).toEqual([
    { id: "hook", x: ownerHook.x, y: ownerHook.y, size: 110 },
    { id: "accent-1", x: engineAccent.x, y: engineAccent.y, size: 77 },
  ]);

  await runWorker();

  // Version 3 is the owner's: after version 2, edited from it; version 2 as it was.
  const after = await versionsOf();
  expect(after.map((version) => version.number)).toEqual([1, 2, 3]);
  const v3 = after[2]!;
  editedVersionId = v3.id;
  expect(v3).toMatchObject({
    parent_id: before[1]!.id,
    edited_from_id: before[1]!.id,
    restored_from_id: null,
  });
  expect(await versionBytes(editedKey)).toBe(editedBytes);
  expect(after[1]!.edited_from_id).toBeNull();

  // The list marks it, the preview switches to it and the editor closes.
  await expect(versionItem(3).getByTestId("version-title")).toHaveText("Edited by you");
  await expect(versionItem(3).getByTestId("version-current")).toBeVisible();
  await expect(versionItem(3)).toHaveAttribute("data-edited", "true");
  await expect(versionItem(2)).not.toHaveAttribute("data-edited", "true");
  await expect(versionItem(2).getByTestId("version-title")).not.toHaveText("Edited by you");
  await expect(page.locator(`[data-preview-version="${v3.id}"]`)).toBeVisible({ timeout: 30_000 });
  await ready();
  await expect(page.getByTestId("move-layer")).toHaveCount(0);
  await versionItem(3).getByTestId("version-toggle").click();
  await expect(versionItem(3).getByTestId("version-origin")).toHaveText("Edited by you");
  await expect(versionItem(3).getByTestId("version-edited-from")).toHaveText(
    "You moved or resized text in v2",
  );

  // The saved version draws the two texts where the draft showed them.
  const hook = await drawn("hook");
  expect(Math.abs(hook.x - ownerHook.x)).toBeLessThan(1);
  expect(Math.abs(hook.y - ownerHook.y)).toBeLessThan(1);
  expect(hook.fontSize).toBe(110);
  const accent = await drawn("accent-1");
  expect([accent.x, accent.y, accent.fontSize]).toEqual([ownerAccent.x, ownerAccent.y, 77]);
  await shot("3-versions-list-edited-by-you.png");
});

test("each moved text leaves a learning record: the engine's box, the owner's and what was on screen", async () => {
  const versions = await versionsOf();
  const moves = await ownerMoves();
  expect(moves.map((move) => move.item)).toEqual(["accent-1", "hook"]);
  const [accent, hook] = moves;
  expect(hook).toMatchObject({
    version_id: editedVersionId,
    from_version_id: versions[1]!.id,
    engine_version_id: versions[1]!.id,
    component: "HOOK",
    text: "A short test for the real studio",
    moved: true,
    resized: false,
  });
  expect(hook!.engine_box).toMatchObject({ x: engineHook.x, y: engineHook.y, size: 110 });
  expect(hook!.owner_box).toMatchObject({ x: ownerHook.x, y: ownerHook.y, size: 110 });
  expect(accent).toMatchObject({ component: "ACCENT", moved: false, resized: true });
  expect(accent!.engine_box).toMatchObject({ size: 110 });
  expect(accent!.owner_box).toMatchObject({ size: 77 });
  const context = hook!.context as {
    frame: unknown;
    font_pair: string;
    others: { item: string; component: string }[];
  };
  expect(context.frame).toEqual({ width: 1080, height: 1920 });
  expect(context.font_pair).toBe("classic");
  // The captions said while the hook shows were on screen with it.
  expect(context.others.some((other) => other.component === "CAPTION")).toBe(true);
});

test("going back to the version before shows the engine's placement again, and the owner's version stays in the list", async () => {
  await versionItem(2).getByTestId("version-toggle").click();
  await versionItem(2).getByRole("button", { name: "Go back to this" }).click();
  await runWorker();
  await expect(versionItem(4).getByTestId("version-title")).toHaveText("Back to v2");
  await expect(versionItem(4).getByTestId("version-current")).toBeVisible();
  await expect(versionItem(3).getByTestId("version-title")).toHaveText("Edited by you");
  const v4 = (await versionsOf())[3]!;
  await expect(page.locator(`[data-preview-version="${v4.id}"]`)).toBeVisible({ timeout: 30_000 });
  await ready();
  const hook = await drawn("hook");
  expect(Math.abs(hook.x - engineHook.x)).toBeLessThan(1);
  expect(Math.abs(hook.y - engineHook.y)).toBeLessThan(1);
});

test("going back to the owner's version brings the moved texts back", async () => {
  await versionItem(3).getByRole("button", { name: "Go back to this" }).click();
  await runWorker();
  await expect(versionItem(5).getByTestId("version-title")).toHaveText("Back to v3");
  await expect(versionItem(5).getByTestId("version-current")).toBeVisible();
  const v5 = (await versionsOf())[4]!;
  expect(v5.restored_from_id).toBe(editedVersionId);
  await expect(page.locator(`[data-preview-version="${v5.id}"]`)).toBeVisible({ timeout: 30_000 });
  await ready();
  const hook = await drawn("hook");
  expect(Math.abs(hook.x - ownerHook.x)).toBeLessThan(1);
  expect(Math.abs(hook.y - ownerHook.y)).toBeLessThan(1);
});

test("Start over makes a new version and leaves the owner's version and its record as they were", async () => {
  const before = await versionsOf();
  const owned = before[2]!;
  const ownedBytes = await versionBytes(owned.r2_key);
  const movesBefore = await ownerMoves();

  await page.getByTestId("start-over").click();
  await runWorker({ E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER });

  await expect(versionItem(6).getByTestId("version-current")).toBeVisible();
  await expect(versionItem(6).getByTestId("version-title")).toHaveText("Styled automatically");
  await expect(versionItem(3).getByTestId("version-title")).toHaveText("Edited by you");
  const after = await versionsOf();
  expect(after.map((version) => version.number)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(after[2]).toEqual(owned);
  expect(after[5]!.edited_from_id).toBeNull();
  expect(await versionBytes(owned.r2_key)).toBe(ownedBytes);
  expect(await ownerMoves()).toEqual(movesBefore);
});

test("another owner cannot queue moves for this reel", async () => {
  const stranger = await createTestUser(admin, "owner-edit-stranger");
  try {
    const { client } = await signedInClient(admin, stranger.email);
    const { error } = await client.from("jobs").insert({
      reel_id: reel!.reelId,
      kind: "owner_edit",
      owner_edit: {
        version_id: editedVersionId,
        moves: [{ id: "hook", x: 100, y: 600, size: 60 }],
      },
    });
    expect(error).not.toBeNull();
    expect((await ownerEditJobs()).length).toBe(1);
  } finally {
    await deleteTestUser(admin, stranger.id);
  }
});
