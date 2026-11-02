import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// A landscape clip (320 x 180, two seconds, with a tone): the footage check
// refuses it at once, before any other step.
const CLIP = new URL("../../../fixtures/footage/landscape.mp4", import.meta.url).pathname;
// This run's own cache folder: nothing may be written under it.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const MESSAGE = "This clip is 320 x 180, not vertical. The studio takes vertical clips only.";

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let sourceKey: string | null = null;

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "footage-refusal");
});

test.afterAll(async () => {
  if (sourceKey) await storage.delete(sourceKey);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a landscape clip is refused at once with its message, live, and nothing else runs", async ({
  page,
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.getByLabel("Clip").setInputFiles(CLIP);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page).toHaveURL(
    /\/studio\/reels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    { timeout: 20_000 },
  );
  const reelId = new URL(page.url()).pathname.split("/").pop()!;
  const { data: reel } = await admin.from("reels").select("source_key").eq("id", reelId).single();
  sourceKey = reel!.source_key as string;

  await expect(page.locator('[data-realtime="ready"]')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  // Refused is not done: `once` exits 1.
  expect(worker.code, worker.output).toBe(1);

  await expect(page.getByTestId("reel-status")).toHaveText("refused", { timeout: 10_000 });
  await expect(page.getByTestId("reel-refusal")).toHaveText(MESSAGE);
  await expect(page.getByRole("alert").filter({ hasText: MESSAGE })).toBeVisible();
  await expect(page.getByTestId("step-line")).toHaveCount(1);
  await expect(page.getByTestId("step-line")).toHaveText(/^check_footage: /);
  await expect(page.getByTestId("job-status")).toHaveText("failed");
  // A refused clip has no Retry: another clip is the only way on.
  await expect(page.getByTestId("job-retry")).toHaveCount(0);
  await expect(page.getByLabel("Ask for a change")).toBeDisabled();
  await expect(page.getByTestId("change-blocked-reason")).toHaveText(
    "This clip was refused; upload another clip.",
  );
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );

  const { data: reelRow } = await admin
    .from("reels")
    .select("status, refusal_message")
    .eq("id", reelId)
    .single();
  expect(reelRow).toEqual({ status: "refused", refusal_message: MESSAGE });
  const { data: steps } = await admin.from("steps").select("name").eq("reel_id", reelId);
  expect(steps).toEqual([{ name: "check_footage" }]);
  const { data: jobs } = await admin
    .from("jobs")
    .select("status, error_tail")
    .eq("reel_id", reelId);
  expect(jobs).toEqual([{ status: "failed", error_tail: MESSAGE }]);
  // Nothing stored by a later step.
  expect(await storage.list(`${CACHE_PREFIX}cache/`)).toEqual([]);
});
