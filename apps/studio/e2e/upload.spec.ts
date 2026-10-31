import { stat } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

const CLIP = new URL("../../../fixtures/footage/short-speech.mp4", import.meta.url).pathname;

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
  owner = await createTestUser(admin, "upload");
});

test.afterAll(async () => {
  if (sourceKey) await storage.delete(sourceKey);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("an uploaded clip is received by the worker and the page updates live", async ({
  page,
  baseURL,
}) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  const clipBytes = (await stat(CLIP)).size;
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.getByLabel("Clip").setInputFiles(CLIP);
  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page).toHaveURL(
    /\/studio\/reels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  const reelId = new URL(page.url()).pathname.split("/").pop()!;

  const { data: reel } = await admin
    .from("reels")
    .select("status, source_bytes, source_key, source_name")
    .eq("id", reelId)
    .single();
  expect(reel).toMatchObject({
    status: "uploaded",
    source_bytes: clipBytes,
    source_name: "short-speech.mp4",
  });
  sourceKey = reel!.source_key as string;
  const { data: jobs } = await admin.from("jobs").select("kind, status").eq("reel_id", reelId);
  expect(jobs).toEqual([{ kind: "process", status: "queued" }]);
  expect(await storage.head(sourceKey)).toEqual({ bytes: clipBytes });

  await expect(page.locator('[data-realtime="ready"]')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const worker = await runWorkerOnce();
  expect(worker.code, worker.output).toBe(0);

  await expect(page.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  await expect(page.getByTestId("step-line")).toContainText(
    /receive: footage received, \d+(\.\d)? (B|KB|MB)/,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("reel-status")).toHaveText("received", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
});
