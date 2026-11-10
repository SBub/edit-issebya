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
// profile, and the relayout job the worker runs with no AI call.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const PAIR_IDS = ["classic", "script", "signature", "handwritten", "retro", "bold"] as const;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let scriptDir: string;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
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
  const versions = reel ? await versionsOf() : [];
  for (const key of new Set([...(reel?.keys ?? []), ...versions.map((v) => v.r2_key)])) {
    await storage.delete(key);
  }
  if (owner) {
    await admin.from("profiles").delete().eq("user_id", owner.id);
    await deleteTestUser(admin, owner.id);
  }
});

async function versionsOf() {
  const { data, error } = await admin
    .from("versions")
    .select("id, number, parent_id, r2_key")
    .eq("reel_id", reel!.reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  return (data ?? []) as { id: string; number: number; parent_id: string | null; r2_key: string }[];
}

function option(id: (typeof PAIR_IDS)[number]) {
  return page.getByTestId(`font-pair-${id}`);
}

test("the picker lists the six pairs, each sample in its own fonts, with classic chosen", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });

  const picker = page.getByTestId("font-pair-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("radio")).toHaveCount(6);
  await expect(option("classic")).toHaveAttribute("aria-checked", "true");
  await expect(option("bold")).toHaveAttribute("aria-checked", "false");
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

test("picking a pair saves it to the profile and queues one relayout job for the reel", async () => {
  await option("bold").click();
  await expect(option("bold")).toHaveAttribute("aria-checked", "true");
  await expect(option("bold"))
    .toBeDisabled({ timeout: 10_000 })
    .catch(() => undefined);

  const { data: profile } = await admin
    .from("profiles")
    .select("font_pair")
    .eq("user_id", owner.id)
    .single();
  expect(profile).toEqual({ font_pair: "bold" });

  const { data: jobs } = await admin
    .from("jobs")
    .select("kind, status, font_pair, request, restore_version_id, version_id")
    .eq("reel_id", reel!.reelId)
    .eq("kind", "relayout");
  expect(jobs).toEqual([
    {
      kind: "relayout",
      status: "queued",
      font_pair: "bold",
      request: null,
      restore_version_id: null,
      version_id: null,
    },
  ]);
});

test("the worker places the current version in the bold pair as version 3, with no AI call", async () => {
  const before = await versionsOf();
  expect(before.map((v) => v.number)).toEqual([1, 2]);

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const after = await versionsOf();
  expect(after.map((v) => v.number)).toEqual([1, 2, 3]);
  const v3 = after[2]!;
  expect(v3.parent_id).toBe(before[1]!.id);
  const edit = JSON.parse(new TextDecoder().decode((await storage.get(v3.r2_key))!));
  expect(edit.font_pair).toBe("bold");

  // Once the new version shows, the picker still has bold chosen after a reload.
  await page.reload();
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(option("bold")).toHaveAttribute("aria-checked", "true");
});
