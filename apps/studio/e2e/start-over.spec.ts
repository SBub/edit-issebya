import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { SHORT_SPEECH_ANSWER, unchangedAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// Start over: a temporary testing control (app_docs/change-requests.md).
// Remove this spec with it.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// The two scripts the composition loads from jsdelivr, served from the pinned
// local packages so the spec needs no network.
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
  owner = await createTestUser(admin, "start-over");
  // Version 2 carries the committed answer's choices, so it differs from version 1.
  reel = await seedProcessedReel({
    admin,
    storage,
    ownerId: owner.id,
    prefix: CACHE_PREFIX,
    aiScript: SHORT_SPEECH_ANSWER,
  });
  scriptDir = await mkdtemp(join(tmpdir(), "start-over-"));
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
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  const versions = reel ? await versionsOf() : [];
  for (const key of new Set([...(reel?.keys ?? []), ...versions.map((v) => v.r2_key)])) {
    await storage.delete(key);
  }
  if (owner) await deleteTestUser(admin, owner.id);
});

async function versionsOf() {
  const { data, error } = await admin
    .from("versions")
    .select("id, number, parent_id, request, r2_key")
    .eq("reel_id", reel!.reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  return (data ?? []) as {
    id: string;
    number: number;
    parent_id: string | null;
    request: string | null;
    r2_key: string;
  }[];
}

async function bytesOf(key: string): Promise<string> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`no blob at ${key}`);
  return new TextDecoder().decode(bytes);
}

function startOver() {
  return page
    .locator('section[aria-labelledby="versions-heading"]')
    .getByRole("button", { name: "Start over" });
}

test("Start over sits by the Versions heading and is off while a job runs", async ({ baseURL }) => {
  // A running process job whose lease is an hour ahead: never claimable.
  const { data: running, error } = await admin
    .from("jobs")
    .insert({
      reel_id: reel!.reelId,
      owner_id: owner.id,
      kind: "process",
      status: "running",
      lease_holder: "e2e-held",
      lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .select("id")
    .single();
  expect(error).toBeNull();

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });

  // Beside the heading, on one line with it.
  const heading = (await page.locator("#versions-heading").boundingBox())!;
  const button = (await startOver().boundingBox())!;
  expect(button.y).toBeLessThan(heading.y + heading.height);
  expect(button.y + button.height).toBeGreaterThan(heading.y);
  expect(button.x).toBeGreaterThan(heading.x + heading.width);

  await expect(startOver()).toBeDisabled();
  await expect(startOver()).toHaveAttribute(
    "title",
    "Waiting: your reel is still being styled. Start over starts right after",
  );

  await admin
    .from("jobs")
    .update({ status: "done", finished_at: new Date().toISOString(), lease_expires_at: null })
    .eq("id", running!.id);
  await expect(startOver()).toHaveAttribute(
    "title",
    "Rerun the first edit from version 1 and save it as a new version",
    { timeout: 10_000 },
  );
  await expect(startOver()).toBeEnabled();
});

test("Start over decides again from version 1 and saves version 3", async () => {
  const before = await versionsOf();
  expect(before.map((v) => v.number)).toEqual([1, 2]);
  const [v1, v2] = before;
  // The committed answer made version 2 differ from version 1.
  expect(await bytesOf(v2!.r2_key)).not.toBe(await bytesOf(v1!.r2_key));

  await startOver().click();
  await expect(startOver()).toBeDisabled();
  await expect(page.locator('[data-overlay-kind="working"]')).toBeVisible({ timeout: 10_000 });
  const { data: jobs } = await admin
    .from("jobs")
    .select("kind, status, request, restore_version_id, version_id")
    .eq("reel_id", reel!.reelId)
    .eq("kind", "start_over");
  expect(jobs).toEqual([
    {
      kind: "start_over",
      status: "queued",
      request: null,
      restore_version_id: null,
      version_id: null,
    },
  ]);

  // An answer with no choices: from version 1 it is version 1 plus the hook,
  // the one thing added (every reel has one now).
  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: await unchangedAnswerScript(scriptDir),
  });
  expect(worker.code, worker.output).toBe(0);

  const after = await versionsOf();
  expect(after.map((v) => v.number)).toEqual([1, 2, 3]);
  const v3 = after[2]!;
  expect(v3).toMatchObject({ parent_id: v2!.id, request: null });
  const v1Edit = JSON.parse(await bytesOf(v1!.r2_key));
  const v3Edit = JSON.parse(await bytesOf(v3.r2_key));
  const hooks = (edit: typeof v1Edit) =>
    edit.tracks.overlays.filter((item: { kind: string }) => item.kind === "hook");
  expect(hooks(v1Edit)).toEqual([]);
  expect(hooks(v3Edit)).toHaveLength(1);
  expect(v3Edit.tracks.overlays.filter((item: { kind: string }) => item.kind !== "hook")).toEqual(
    v1Edit.tracks.overlays,
  );
  expect(v3Edit.tracks.captions).toEqual(v1Edit.tracks.captions);
  expect(v3Edit.tracks.transitions).toEqual(v1Edit.tracks.transitions);
  const { data: reelRow } = await admin
    .from("reels")
    .select("status, current_version_id")
    .eq("id", reel!.reelId)
    .single();
  expect(reelRow).toEqual({ status: "processed", current_version_id: v3.id });

  // The list shows the new version current, the older ones kept.
  const item = (n: number) =>
    page.locator(`[data-testid="version-item"][data-version-number="${n}"]`);
  await expect(item(3).getByTestId("version-current")).toBeVisible({ timeout: 10_000 });
  await expect(item(2)).toBeVisible();
  await expect(item(1)).toBeVisible();
  await expect(startOver()).toBeEnabled({ timeout: 10_000 });
});
