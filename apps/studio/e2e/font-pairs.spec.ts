import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { SHORT_SPEECH_ANSWER } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// Font pairs (app_docs/font-pairs.md): the picker on the reel page, the owner's
// profile, and the relayout job the worker runs with no AI call. Two reels of
// one owner: the chosen option is each reel's own pair, and the "Last used"
// badge sits on the profile's pair.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const PAIR_IDS = ["classic", "script", "signature", "handwritten", "retro", "bold"] as const;
type PairId = (typeof PAIR_IDS)[number];

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
// Both reels are classic when seeded (no profile row yet).
let reel: ProcessedReel | null = null;
let other: ProcessedReel | null = null;
let scriptDir: string;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "font-pairs");
  // Version 2 carries the committed answer, so the relayout has an answer to place.
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    aiScript: SHORT_SPEECH_ANSWER,
  });
  other = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    aiScript: SHORT_SPEECH_ANSWER,
  });
  scriptDir = await mkdtemp(join(tmpdir(), "font-pairs-"));
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page?.context().close();
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  for (const processed of [reel, other]) {
    if (!processed) continue;
    const versions = await versionsOf(processed.reelId);
    for (const key of new Set([...processed.keys, ...versions.map((v) => v.r2_key)])) {
      await storage.delete(key);
    }
  }
  if (owner) {
    await admin.from("profiles").delete().eq("user_id", owner.id);
    await deleteTestUser(admin, owner.id);
  }
});

async function versionsOf(reelId: string) {
  const { data, error } = await admin
    .from("versions")
    .select("id, number, parent_id, r2_key")
    .eq("reel_id", reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  return (data ?? []) as { id: string; number: number; parent_id: string | null; r2_key: string }[];
}

async function relayoutJobsOf(reelId: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("id, status, font_pair")
    .eq("reel_id", reelId)
    .eq("kind", "relayout");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return data ?? [];
}

async function profilePair() {
  const { data } = await admin.from("profiles").select("font_pair").eq("user_id", owner.id);
  return data?.[0]?.font_pair ?? "classic";
}

async function openReel(reelId: string) {
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("font-pair-picker")).toBeVisible();
}

function option(id: PairId) {
  return page.getByTestId(`font-pair-${id}`);
}

// The one option that carries the "Last used" badge.
async function lastUsedOption(): Promise<PairId | null> {
  await expect(page.getByTestId("font-pair-last-used")).toHaveCount(1);
  for (const id of PAIR_IDS) {
    if ((await option(id).getByTestId("font-pair-last-used").count()) === 1) return id;
  }
  return null;
}

test("the picker lists the six pairs, each sample in its own fonts, with classic chosen", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await openReel(reel!.reelId);

  const picker = page.getByTestId("font-pair-picker");
  await expect(picker.getByRole("radio")).toHaveCount(6);
  await expect(option("classic")).toHaveAttribute("aria-checked", "true");
  await expect(option("bold")).toHaveAttribute("aria-checked", "false");
  // No profile row yet: classic is the profile's pair too, so it is "Last used".
  await expect(option("classic").getByTestId("font-pair-last-used")).toHaveText("Last used");
  // The sample is written in the pair's simple and artistic faces.
  await expect(page.getByTestId("font-pair-sample-classic").locator("span").first()).toHaveCSS(
    "font-family",
    /Inter Tight SemiBold/,
  );
  await expect(page.getByTestId("font-pair-sample-classic").locator("span").last()).toHaveCSS(
    "font-style",
    "italic",
  );
  await expect(page.getByTestId("font-pair-sample-bold").locator("span").first()).toHaveCSS(
    "font-family",
    /Archivo Expanded Black/,
  );
});

test("picking a pair saves it to the profile, moves the badge and queues one relayout job", async () => {
  await option("bold").click();
  // The badge moves to the pair saved to the profile at once.
  await expect(option("bold").getByTestId("font-pair-last-used")).toHaveText("Last used");
  await expect(option("classic").getByTestId("font-pair-last-used")).toHaveCount(0);
  // Off while the relayout is queued: the other pairs are disabled.
  await expect(option("script")).toBeDisabled();
  // The reel is still set in classic until its new version is saved.
  await expect(option("classic")).toHaveAttribute("aria-checked", "true");

  expect(await profilePair()).toBe("bold");
  expect(await relayoutJobsOf(reel!.reelId)).toEqual([
    { id: expect.any(String), status: "queued", font_pair: "bold" },
  ]);
});

test("the worker places the current version in the bold pair as version 3, with no AI call", async () => {
  const before = await versionsOf(reel!.reelId);
  expect(before.map((v) => v.number)).toEqual([1, 2]);

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const after = await versionsOf(reel!.reelId);
  expect(after.map((v) => v.number)).toEqual([1, 2, 3]);
  const v3 = after[2]!;
  expect(v3.parent_id).toBe(before[1]!.id);
  const edit = JSON.parse(new TextDecoder().decode((await storage.get(v3.r2_key))!));
  expect(edit.font_pair).toBe("bold");

  // The picker follows the new current version: bold is chosen, after a reload too.
  await openReel(reel!.reelId);
  await expect(option("bold")).toHaveAttribute("aria-checked", "true");
  await expect(option("classic")).toHaveAttribute("aria-checked", "false");
  await expect(option("bold").getByTestId("font-pair-last-used")).toHaveText("Last used");
});

test("a second reel shows its own pair chosen while the badge stays on the profile's pair", async () => {
  await openReel(other!.reelId);
  await expect(option("classic")).toHaveAttribute("aria-checked", "true");
  await expect(option("bold")).toHaveAttribute("aria-checked", "false");
  await expect(option("bold").getByTestId("font-pair-last-used")).toHaveText("Last used");
  expect(await lastUsedOption()).toBe("bold");
});

test("picking another pair on the second reel leaves the first reel's pair alone", async () => {
  await option("signature").click();
  await expect(option("signature").getByTestId("font-pair-last-used")).toHaveText("Last used");
  await expect(option("bold").getByTestId("font-pair-last-used")).toHaveCount(0);
  expect(await profilePair()).toBe("signature");
  expect(await relayoutJobsOf(other!.reelId)).toEqual([
    { id: expect.any(String), status: "queued", font_pair: "signature" },
  ]);

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);
  const versions = await versionsOf(other!.reelId);
  expect(versions.map((v) => v.number)).toEqual([1, 2, 3]);

  await openReel(other!.reelId);
  await expect(option("signature")).toHaveAttribute("aria-checked", "true");
  await expect(option("classic")).toHaveAttribute("aria-checked", "false");
  await expect(option("signature").getByTestId("font-pair-last-used")).toHaveText("Last used");
});

test("back on the first reel, bold is chosen and the badge stays on signature", async () => {
  await openReel(reel!.reelId);
  await expect(option("bold")).toHaveAttribute("aria-checked", "true");
  await expect(option("signature")).toHaveAttribute("aria-checked", "false");
  await expect(option("signature").getByTestId("font-pair-last-used")).toHaveText("Last used");
  await expect(option("bold").getByTestId("font-pair-last-used")).toHaveCount(0);
});

test("clicking the pair the reel is already set in does nothing", async () => {
  const jobsBefore = await relayoutJobsOf(reel!.reelId);
  await option("bold").click();
  await expect(option("bold")).toHaveAttribute("aria-checked", "true");
  expect(await relayoutJobsOf(reel!.reelId)).toEqual(jobsBefore);
  expect(await profilePair()).toBe("signature");
});
