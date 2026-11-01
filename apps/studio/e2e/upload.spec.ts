import { stat } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { eventsNamed, recordEvents } from "./events.ts";
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
const workerId = `e2e-${crypto.randomUUID()}`;

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
  await admin.from("worker_status").delete().eq("worker_id", workerId);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("an uploaded clip is received by the worker and the page updates live", async ({
  page,
  baseURL,
}) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  const clipBytes = (await stat(CLIP)).size;
  const events = await recordEvents(page);
  // PostHog never initialises under Playwright: no request may reach it.
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  const posthogRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.host.includes("posthog") || (posthogHost && request.url().startsWith(posthogHost))) {
      posthogRequests.push(request.url());
    }
  });
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.getByLabel("Clip").setInputFiles(CLIP);
  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page).toHaveURL(
    /\/studio\/reels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  const reelId = new URL(page.url()).pathname.split("/").pop()!;
  await expect
    .poll(() => eventsNamed(events, "studio_footage_uploaded"))
    .toEqual([
      { event: "studio_footage_uploaded", properties: { app: "studio", reel_id: reelId } },
    ]);

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

  const worker = await runWorkerOnce({ WORKER_ID: workerId });
  expect(worker.code, worker.output).toBe(0);

  await expect(page.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  await expect(page.getByTestId("step-line")).toContainText(
    /receive: footage received, (under a second|\d+ seconds?), \d+(\.\d)? (B|KB|MB)/,
    { timeout: 10_000 },
  );
  // An in-process step: wall time only, the other measurements null.
  const { data: steps } = await admin
    .from("steps")
    .select("name, wall_ms, cpu_ms, peak_rss_bytes, bytes_in, bytes_out")
    .eq("reel_id", reelId);
  expect(steps).toEqual([
    {
      name: "receive",
      wall_ms: expect.any(Number),
      cpu_ms: null,
      peak_rss_bytes: null,
      bytes_in: null,
      bytes_out: null,
    },
  ]);
  expect(steps![0]!.wall_ms).toBeGreaterThanOrEqual(0);
  // The upload recorded its source, and every object of the reel has exactly one live row.
  const { data: files } = await admin
    .from("stored_files")
    .select("kind, step, r2_key, bytes, deleted_at")
    .eq("reel_id", reelId);
  expect(files).toEqual([
    { kind: "source", step: "upload", r2_key: sourceKey, bytes: clipBytes, deleted_at: null },
  ]);
  const reelPrefix = sourceKey.slice(0, sourceKey.indexOf("/source/") + 1);
  expect(await storage.list(reelPrefix)).toEqual(
    files!
      .filter((file) => file.deleted_at === null)
      .map((file) => file.r2_key)
      .sort(),
  );
  await expect(page.getByTestId("reel-status")).toHaveText("received", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
  expect(posthogRequests).toEqual([]);
});
