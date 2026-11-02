import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { unchangedAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { seedPipelineCache } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The ready notice: with the tab hidden, the reel turning `processed` changes
// the title and shows one notification (turned on from the "Notify me"
// click); the title comes back when the tab is visible; with the tab visible a
// new export does neither. The page's Notification is a spy and its
// visibility a switch the spec flips.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const CLIP = new URL("../../../fixtures/footage/short-speech.mp4", import.meta.url);
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

interface SpyWindow {
  __notifications: { title: string; body: string | undefined }[];
  __hidden: boolean;
}

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reelId: string | null = null;
let page: Page;
let scriptDir: string;
let aiScript: string;
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
  owner = await createTestUser(admin, "notification");
  scriptDir = await mkdtemp(join(tmpdir(), "ai-script-"));
  aiScript = await unchangedAnswerScript(scriptDir);

  // An uploaded reel with its queued process job, the cache seeded; the
  // worker runs inside the test, with the tab hidden.
  reelId = crypto.randomUUID();
  const sourceKey = `${CACHE_PREFIX}reels/${reelId}/source/original.mp4`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  await storage.put(sourceKey, new Uint8Array(await readFile(CLIP)));
  written.add(sourceKey);
  for (const key of await seedPipelineCache(storage, CACHE_PREFIX)) written.add(key);
  const reel = await admin.from("reels").insert({
    id: reelId,
    owner_id: owner.id,
    status: "uploaded",
    source_key: sourceKey,
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
    source_bytes: (await stat(CLIP)).size,
    source_name: "short-speech.mp4",
  });
  if (reel.error) throw new Error(`reel not inserted: ${reel.error.message}`);
  const job = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, kind: "process", status: "queued" });
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);

  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
    permissions: ["notifications"],
  });
  await context.addInitScript(() => {
    const spy = window as unknown as SpyWindow & { Notification: typeof Notification };
    // Headless Chromium reports Notification.permission as "denied" even with
    // the permission granted, so the spy keeps its own: "default" until the
    // click asks, then "granted".
    let permission: NotificationPermission = "default";
    spy.__notifications = [];
    spy.__hidden = false;
    class NotificationSpy {
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        spy.__notifications.push({ title, body: options?.body });
      }
      static get permission() {
        return permission;
      }
      static requestPermission() {
        permission = "granted";
        return Promise.resolve(permission);
      }
    }
    spy.Notification = NotificationSpy as unknown as typeof Notification;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (spy.__hidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => spy.__hidden,
    });
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
  if (reelId) {
    const { data } = await admin.from("exports").select("r2_key").eq("reel_id", reelId);
    for (const row of (data ?? []) as { r2_key: string }[]) written.add(row.r2_key);
    const { data: versions } = await admin.from("versions").select("id").eq("reel_id", reelId);
    for (const row of (versions ?? []) as { id: string }[]) {
      written.add(`${CACHE_PREFIX}reels/${reelId}/versions/${row.id}.json`);
    }
    // Leave nothing claimable for the next spec, even after a failure here.
    await admin.from("jobs").delete().eq("reel_id", reelId).eq("status", "queued");
  }
  for (const key of written) await storage.delete(key);
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  if (owner) await deleteTestUser(admin, owner.id);
});

function setHidden(hidden: boolean) {
  return page.evaluate((value) => {
    (window as unknown as SpyWindow).__hidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

const notifications = () => page.evaluate(() => (window as unknown as SpyWindow).__notifications);

test("a reel processed while the tab is hidden changes the title and notifies", async ({
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  const originalTitle = await page.title();

  // The toggle is replaced by notify-blocked when the page's permission is
  // "denied" (the b5cfbf15 failure: the spy delegated to headless Chromium's
  // real permission). Check that state first so a regression names its cause.
  expect(await page.evaluate(() => Notification.permission)).toBe("default");
  await expect(page.getByTestId("notify-blocked")).toHaveCount(0);
  const toggle = page.getByTestId("notify-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText("Notify me when ready");
  await toggle.click();
  await expect(toggle).toHaveText("Notifications on");

  await setHidden(true);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_AI_SCRIPT: aiScript });
  expect(worker.code, worker.output).toBe(0);
  await expect(page.getByTestId("reel-status")).toHaveText("processed", { timeout: 10_000 });
  await expect(page).toHaveTitle("Ready: short-speech.mp4");
  await expect.poll(notifications).toHaveLength(1);
  expect((await notifications())[0]!.title).toBe("Ready: short-speech.mp4");

  await setHidden(false);
  await expect(page).toHaveTitle(originalTitle);
});

test("a new export with the tab visible changes nothing", async () => {
  test.setTimeout(120_000);
  const before = await notifications();
  const title = await page.title();
  const { data: reel } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reelId!)
    .single();
  const queued = await admin.from("jobs").insert({
    reel_id: reelId,
    owner_id: owner.id,
    kind: "render",
    version_id: (reel as { current_version_id: string }).current_version_id,
  });
  expect(queued.error).toBeNull();
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);
  await expect(page.getByTestId("export-link")).toBeVisible({ timeout: 10_000 });
  expect(await notifications()).toEqual(before);
  expect(await page.title()).toBe(title);
});
