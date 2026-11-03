import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import {
  SHORT_SPEECH_ANSWER,
  SLOWER_TRANSITIONS_SUMMARY,
  slowerTransitionsAnswerScript,
} from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const REQUEST = "make the transitions slower";
// The committed answer's dim carries "clip for the" (w0006 to w0008) as its
// lead-in and "real Studio" (w0009, w0010) as its key phrase. w0006 starts at
// 1.252 s: the dim comes in 0.3 s before it; nothing follows w0010, so it
// stays to the reel's end (2.690 s).
const DIM_START = "0.952";
const SLOWER_START = "0.652";
const REEL_END = 2.69;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let scriptDir: string;
let page: Page;
const versionKeys: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "transitions");
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    aiScript: SHORT_SPEECH_ANSWER,
  });
  scriptDir = await mkdtemp(join(tmpdir(), "transitions-"));
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
  await routePreviewCdn(page);
});

test.afterAll(async () => {
  await page?.context().close();
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  for (const key of new Set([...(reel?.keys ?? []), ...versionKeys])) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

async function editAt(key: string) {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`no blob at ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as {
    tracks: { transitions: Record<string, unknown>[] };
  };
}

// The composition's frame, inside the player's open shadow root.
function composition() {
  return page.frameLocator("hyperframes-player iframe");
}

function versionItem(number: number) {
  return page.locator(`[data-testid="version-item"][data-version-number="${number}"]`);
}

async function layerEnd(): Promise<number> {
  const dim = composition().locator("#dim-clip");
  const start = Number(await dim.getAttribute("data-start"));
  const duration = Number(await dim.getAttribute("data-duration"));
  return Math.round((start + duration) * 1000) / 1000;
}

test("a fresh reel's transition carries its words and sits on them in the live preview", async ({
  baseURL,
}) => {
  // Version 2 stores the phrase, never times.
  const edit = await editAt(reel!.versionKey);
  expect(edit.tracks.transitions).toEqual([
    { id: "dim-clip", type: "dim", from: "w0006", key_from: "w0009", to: "w0010" },
  ]);
  for (const transition of edit.tracks.transitions) {
    expect(transition).not.toHaveProperty("start");
    expect(transition).not.toHaveProperty("end");
  }

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(`[data-preview-version="${reel!.versionId}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const dim = composition().locator("#dim-clip");
  await expect(dim).toHaveAttribute("data-start", DIM_START);
  expect(await layerEnd()).toBe(REEL_END);
  await expect(composition().locator("#dim-clip-lead")).toHaveText("clip for the");
  await expect(composition().locator("#dim-clip-key")).toHaveText("real Studio");
  // The phrase's captions are shown only inside the transition.
  for (const id of ["cw0006", "cw0007", "cw0008", "cw0009", "cw0010"]) {
    await expect(composition().locator(`#${id}`)).toHaveCount(0);
  }
});

test("make the transitions slower lengthens the motion and says so, without a reload", async () => {
  await page.getByLabel("Ask for a change").fill(REQUEST);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("change-pending")).toHaveText(`Pending: ${REQUEST}`);

  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: await slowerTransitionsAnswerScript(scriptDir),
  });
  expect(worker.code, worker.output).toBe(0);

  const { data, error } = await admin
    .from("versions")
    .select("id, number, change_summary, r2_key")
    .eq("reel_id", reel!.reelId)
    .eq("number", 3)
    .single();
  expect(error).toBeNull();
  const v3 = data as { id: string; change_summary: string; r2_key: string };
  versionKeys.push(v3.r2_key);
  expect((await editAt(v3.r2_key)).tracks.transitions).toEqual([
    {
      id: "dim-clip",
      type: "dim",
      from: "w0006",
      key_from: "w0009",
      to: "w0010",
      motion_seconds: 0.6,
    },
  ]);

  await expect(page.locator(`[data-preview-version="${v3.id}"][data-preview="ready"]`)).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(composition().locator("#dim-clip")).toHaveAttribute("data-start", SLOWER_START);
  expect(await layerEnd()).toBe(REEL_END);
  await expect(versionItem(3).getByTestId("version-summary")).toHaveText(
    SLOWER_TRANSITIONS_SUMMARY,
  );
  await expect(versionItem(3).getByTestId("version-current")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
});
