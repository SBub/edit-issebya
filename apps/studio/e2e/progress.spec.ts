import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The render step's progress rising live: the render double replays a real
// HyperFrames render's `@hf-progress` lines over 25 seconds, so the worker's
// fixed 10-second throttle writes at least two percentages before 100.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const CDN = [
  {
    url: "https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.222/dist/hyperframe.runtime.iife.js",
    path: fileURLToPath(
      new URL(
        "dist/hyperframe.runtime.iife.js",
        import.meta.resolve("@hyperframes/core/package.json"),
      ),
    ),
  },
  {
    url: "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
    path: fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
  },
];

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let page: Page;
const written = new Set<string>();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "progress");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  for (const key of reel.keys) written.add(key);

  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
  for (const { url, path } of CDN) {
    await page.route(url, (route) =>
      route.fulfill({ path, contentType: "application/javascript" }),
    );
  }
});

test.afterAll(async () => {
  await page?.context().close();
  if (reel) {
    const { data } = await admin.from("exports").select("r2_key").eq("reel_id", reel.reelId);
    for (const row of (data ?? []) as { r2_key: string }[]) written.add(row.r2_key);
    // Leave nothing claimable for the next spec, even after a failure here.
    await admin.from("jobs").delete().eq("reel_id", reel.reelId).eq("status", "queued");
  }
  for (const key of written) await storage.delete(key);
  // The cascade removes the reel, its jobs, steps, versions, exports and stored files.
  if (owner) await deleteTestUser(admin, owner.id);
});

test("a running render shows its percentage rising live and the time left", async ({ baseURL }) => {
  test.setTimeout(150_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  const queued = await admin.from("jobs").insert({
    reel_id: reel!.reelId,
    owner_id: owner.id,
    kind: "render",
    version_id: reel!.versionId,
  });
  expect(queued.error).toBeNull();
  const worker = runWorkerOnce(
    { R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER_SECONDS: "25" },
    { timeoutMs: 90_000 },
  );

  const renderLine = page.locator("li", {
    has: page.getByTestId("step-line").filter({ hasText: /^render: / }),
  });
  const progress = renderLine.getByTestId("step-progress");
  await expect(progress).toHaveText(/^\d{1,2}%$/, { timeout: 30_000 });
  const first = Number((await progress.textContent())!.replace("%", ""));
  expect(first).toBeLessThan(100);
  // A fresh owner has no earlier render rows to estimate from.
  await expect(renderLine.getByTestId("step-time-left")).toHaveText("no estimate yet");
  await expect
    .poll(async () => Number(((await progress.textContent()) ?? "").replace("%", "")), {
      timeout: 30_000,
    })
    .toBeGreaterThan(first);

  const { code, output } = await worker;
  expect(code, output).toBe(0);
  await expect(renderLine.getByTestId("step-line")).toHaveText(/^render: exported/, {
    timeout: 10_000,
  });
  await expect(renderLine.getByTestId("step-progress")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );

  const { data: step, error } = await admin
    .from("steps")
    .select("status, progress_percent")
    .eq("reel_id", reel!.reelId)
    .eq("name", "render")
    .single();
  expect(error).toBeNull();
  expect(step).toEqual({ status: "done", progress_percent: 100 });
});
