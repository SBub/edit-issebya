import { readFile } from "node:fs/promises";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type QueuedReel, seedQueuedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// Verification 2: a landscape clip is refused by the footage check before any
// heavy step, the message shown live. Its facts are seeded under their
// fingerprint (fixtures/footage-check/), so no ffprobe runs here or in CI.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const CHECK_FIXTURES = new URL("../../../fixtures/footage-check/", import.meta.url);

interface CheckManifest {
  clips: { file: string; fingerprint: string; files: string[]; refusal: string }[];
}

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: QueuedReel | null = null;
let refusal: string;
let page: Page;
const written = new Set<string>();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed manifest
    await readFile(new URL("manifest.json", CHECK_FIXTURES), "utf8"),
  ) as CheckManifest;
  const clip = manifest.clips.find((entry) => entry.file === "landscape.mp4")!;
  refusal = clip.refusal;

  owner = await createTestUser(admin, "refusal");
  reel = await seedQueuedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    clip: new URL(clip.file, CHECK_FIXTURES),
    seedCache: false,
  });
  for (const key of reel.keys) written.add(key);
  for (const file of clip.files) {
    const key = `${CACHE_PREFIX}cache/check_footage/${clip.fingerprint}/${file}`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    const body = await readFile(new URL(`landscape/${file}`, CHECK_FIXTURES));
    await storage.put(key, new Uint8Array(body));
    written.add(key);
  }

  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page?.context().close();
  // Leave nothing claimable for the next spec, even after a failure here.
  if (reel) await admin.from("jobs").delete().eq("reel_id", reel.reelId).eq("status", "queued");
  for (const key of written) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a landscape clip is refused at once, the message live, no other step", async ({
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);
  expect(worker.output).toContain("footage refused");

  await expect(page.getByTestId("reel-status")).toHaveText("refused", { timeout: 10_000 });
  await expect(page.getByTestId("reel-refusal")).toHaveText(refusal);
  await expect(page.getByTestId("step-line")).toHaveCount(1);
  await expect(page.getByTestId("step-line")).toHaveText(/^check_footage: /);
  await expect(page.getByTestId("job-status")).toHaveText("failed");
  await expect(page.getByTestId("job-retry")).toHaveCount(0);
  await expect(page.getByLabel("Ask for a change")).toBeDisabled();
  await expect(page.getByTestId("change-blocked-reason")).toHaveText(
    "This clip was refused; upload another.",
  );
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );

  const { data: steps } = await admin
    .from("steps")
    .select("name, status, error_tail")
    .eq("reel_id", reel!.reelId);
  expect(steps).toEqual([{ name: "check_footage", status: "failed", error_tail: refusal }]);
  const { data: row } = await admin
    .from("reels")
    .select("status, refusal_message")
    .eq("id", reel!.reelId)
    .single();
  expect(row).toEqual({ status: "refused", refusal_message: refusal });
  const { data: job } = await admin
    .from("jobs")
    .select("status, error_tail")
    .eq("id", reel!.jobId)
    .single();
  expect(job).toEqual({ status: "failed", error_tail: refusal });
});
