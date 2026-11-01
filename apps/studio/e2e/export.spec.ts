import { type Page, expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { readManifest, seedProcessedReel } from "../test-support/pipeline.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const DAY_MS = 24 * 60 * 60 * 1000;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
const storedKeys: string[] = [];
let owner: { id: string; email: string };
let reelId: string;
let renderJobId: string;

interface ExportRow {
  id: string;
  job_id: string;
  version_id: string;
  r2_key: string;
  created_at: string;
  expires_at: string;
}

async function openReel(page: Page, baseURL: string) {
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function markNoReload(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });
}

async function expectNoReload(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
}

async function currentVersionId(): Promise<string> {
  const { data, error } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reelId)
    .single();
  if (error || !data?.current_version_id) throw new Error(`reel not read: ${error?.message}`);
  return data.current_version_id as string;
}

async function renderJobs() {
  const { data, error } = await admin
    .from("jobs")
    .select("id, kind, status, version_id")
    .eq("reel_id", reelId)
    .eq("kind", "render");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return data as { id: string; kind: string; status: string; version_id: string | null }[];
}

const exportButton = (page: Page) => page.getByRole("button", { name: "Export", exact: true });

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "export");
  reelId = await insertReel(admin, {
    ownerId: owner.id,
    name: "short-speech.mp4",
    status: "uploaded",
  });
  // Version 1 current, both full-size inputs and the preview copies stored.
  const version = await seedProcessedReel(admin, storage, { prefix: CACHE_PREFIX, reelId });
  storedKeys.push(version.r2_key);
  for (const step of (await readManifest()).steps) {
    for (const file of step.files) {
      storedKeys.push(`${CACHE_PREFIX}cache/${step.name}/${step.fingerprint}/${file}`);
    }
  }
});

test.afterAll(async () => {
  for (const key of storedKeys) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("Export renders the current version and shows a download link without a reload", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  await openReel(page, baseURL!);
  await markNoReload(page);

  await expect(exportButton(page)).toBeEnabled();
  await expect(page.getByTestId("export-download")).toHaveCount(0);
  await exportButton(page).click();

  const versionId = await currentVersionId();
  await expect
    .poll(async () =>
      (await renderJobs()).map(({ status, version_id }) => ({ status, version_id })),
    )
    .toEqual([{ status: "queued", version_id: versionId }]);
  renderJobId = (await renderJobs())[0]!.id;
  await expect(exportButton(page)).toBeDisabled({ timeout: 10_000 });
  await expect(page.getByTestId("export-blocked")).toHaveText("Exporting this version.");
  await expect
    .poll(() => eventsNamed(events, "studio_export_requested"))
    .toEqual([
      { event: "studio_export_requested", properties: { app: "studio", reel_id: reelId } },
    ]);

  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER: "true" });
  expect(worker.code, worker.output).toBe(0);

  await expect(page.getByTestId("export-download")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("export-download")).toContainText("Download version 1");
  await expect(page.getByTestId("step-line").last()).toHaveText(/^render: exported, /);
  const renderJob = page.getByRole("listitem").filter({ hasText: "export of version 1" });
  await expect(renderJob.getByTestId("job-status")).toHaveText("done");
  await expectNoReload(page);

  const { data: exports, error } = await admin
    .from("exports")
    .select("id, job_id, version_id, r2_key, created_at, expires_at")
    .eq("reel_id", reelId);
  if (error) throw new Error(`exports not read: ${error.message}`);
  const rows = exports as ExportRow[];
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  storedKeys.push(row.r2_key);
  expect(row).toMatchObject({ job_id: renderJobId, version_id: versionId });
  expect(row.r2_key).toBe(`${CACHE_PREFIX}exports/${reelId}/${row.id}.mp4`);
  expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(DAY_MS);
  expect(await storage.head(row.r2_key)).not.toBeNull();

  const download = page.waitForEvent("download");
  await page.getByTestId("export-download").click();
  const name = (await download).suggestedFilename();
  expect(name.startsWith(`reel-${reelId.slice(0, 8)}-`)).toBe(true);
  expect(name).toMatch(/-\d{8}-\d{4}\.mp4$/);
  await expect
    .poll(() => eventsNamed(events, "studio_export_downloaded"))
    .toEqual([
      { event: "studio_export_downloaded", properties: { app: "studio", reel_id: reelId } },
    ]);
  await expect(exportButton(page)).toBeEnabled();
});

test("an export past its expiry shows expired and no link", async ({ page, baseURL }) => {
  const versionId = await currentVersionId();
  const id = crypto.randomUUID();
  const key = `${CACHE_PREFIX}exports/${reelId}/${id}.mp4`;
  const { error } = await admin.from("exports").insert({
    id,
    reel_id: reelId,
    owner_id: owner.id,
    job_id: renderJobId,
    version_id: versionId,
    r2_key: key,
    bytes: 1000,
    created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw new Error(`export not inserted: ${error.message}`);
  // Newer than test 1's export: the expired one is the newest.
  await admin
    .from("exports")
    .update({ created_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString() })
    .eq("reel_id", reelId)
    .neq("id", id);

  await openReel(page, baseURL!);
  await expect(page.getByTestId("export-expired")).toHaveText("expired, export again");
  await expect(page.getByTestId("export-download")).toHaveCount(0);
});
