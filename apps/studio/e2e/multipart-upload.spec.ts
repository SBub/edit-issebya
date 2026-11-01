import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, type Route, expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { writeFootage } from "../test-support/footage.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

// The resumable upload, through the storage double: under E2E_MOCK_STORAGE
// every part URL is the mock route with `uploadId` and `partNumber`, so the
// spec sees, counts and interrupts each part request.

const STORAGE_ROOT = e2eStorageRoot(new URL(".", import.meta.url).pathname);
const admin = localSupabaseAdmin();
const storage = fakeStorage({ root: STORAGE_ROOT, uploadUrlBase: "" });
const REEL_URL = /\/studio\/reels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dir: string;
let footage: { path: string; bytes: number; sha256: string };
let owner: { id: string; email: string };
let other: { id: string; email: string };
const uploads: { key: string; uploadId: string }[] = [];

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  dir = await mkdtemp(join(tmpdir(), "multipart-upload-"));
  footage = await writeFootage(dir);
  owner = await createTestUser(admin, "multipart");
  other = await createTestUser(admin, "multipart-other");
});

test.afterAll(async () => {
  for (const { key, uploadId } of uploads) {
    await storage.abortMultipartUpload(key, { uploadId });
    await storage.delete(key);
  }
  if (owner) {
    await admin.from("jobs").delete().eq("owner_id", owner.id);
    await deleteTestUser(admin, owner.id);
  }
  if (other) await deleteTestUser(admin, other.id);
  if (dir) await rm(dir, { recursive: true, force: true });
});

function isPart(url: string): boolean {
  const { pathname, searchParams } = new URL(url);
  return pathname.includes("/api/e2e-storage-mock/") && searchParams.has("partNumber");
}

// How many times each part number was PUT.
function countParts(page: Page) {
  const counts: Record<number, number> = {};
  page.on("request", (request) => {
    if (request.method() !== "PUT" || !isPart(request.url())) return;
    const part = Number(new URL(request.url()).searchParams.get("partNumber"));
    counts[part] = (counts[part] ?? 0) + 1;
  });
  return counts;
}

// The highest value the progress bar showed, kept across the client-side
// navigation to the reel page.
async function watchProgress(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __maxProgress: number };
    w.__maxProgress = 0;
    setInterval(() => {
      const bar = document.querySelector<HTMLProgressElement>('[data-testid="upload-progress"]');
      if (bar) w.__maxProgress = Math.max(w.__maxProgress, bar.value);
    }, 10);
  });
}

async function signIn(page: Page, email: string, baseURL: string) {
  await page.goto(await signInLink(admin, email, baseURL));
  await expect(page.getByLabel("Clip")).toBeVisible();
}

async function pickAndUpload(page: Page) {
  await page.getByLabel("Clip").setInputFiles(footage.path);
  await page.getByRole("button", { name: "Upload" }).click();
}

// The owner's newest reel that is still uploading, once its upload exists.
// A reel an earlier spec already claimed (Ownership leaves one uploading) is
// skipped, so a spec never picks it up before its own create lands.
async function uploadingReel(ownerId: string) {
  let row: { id: string; source_key: string; source_upload_id: string } | null = null;
  await expect
    .poll(async () => {
      const { data } = await admin
        .from("reels")
        .select("id, source_key, source_upload_id")
        .eq("owner_id", ownerId)
        .eq("status", "uploading")
        .order("created_at", { ascending: false });
      const claimed = new Set(uploads.map((upload) => upload.uploadId));
      row =
        (data as (typeof row)[] | null)?.find(
          (candidate) => candidate && !claimed.has(candidate.source_upload_id),
        ) ?? null;
      return row?.source_upload_id ?? null;
    })
    .not.toBeNull();
  const found = row!;
  uploads.push({ key: found.source_key, uploadId: found.source_upload_id });
  return found;
}

// The finished reel's row, jobs and stored object; its process job is removed
// so no claimable job is left for the other specs.
async function finished(reelId: string) {
  const { data: reel } = await admin
    .from("reels")
    .select("status, source_bytes, source_key, source_upload_id")
    .eq("id", reelId)
    .single();
  const { data: jobs } = await admin.from("jobs").select("kind, status").eq("reel_id", reelId);
  await admin.from("jobs").delete().eq("reel_id", reelId);
  const key = reel!.source_key as string;
  uploads.push({ key, uploadId: reel!.source_upload_id as string });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a key inside the storage double's folder
  const stored = await readFile(join(STORAGE_ROOT, key));
  return {
    reel: { status: reel!.status, source_bytes: reel!.source_bytes },
    jobs,
    sha256: createHash("sha256").update(stored).digest("hex"),
  };
}

const ONE_JOB = [{ kind: "process", status: "queued" }];

test("Parts: a 35 MiB clip goes up in four 10 MiB parts with a progress bar", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  await watchProgress(page);
  const counts = countParts(page);
  await signIn(page, owner.email, baseURL!);
  await pickAndUpload(page);

  await expect(page).toHaveURL(REEL_URL, { timeout: 60_000 });
  const reelId = new URL(page.url()).pathname.split("/").pop()!;
  expect(counts).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1 });
  expect(
    await page.evaluate(() => (window as unknown as { __maxProgress: number }).__maxProgress),
  ).toBe(100);
  expect(await finished(reelId)).toEqual({
    reel: { status: "uploaded", source_bytes: 36700160 },
    jobs: ONE_JOB,
    sha256: footage.sha256,
  });
  await expect
    .poll(() => eventsNamed(events, "studio_footage_uploaded"))
    .toEqual([
      { event: "studio_footage_uploaded", properties: { app: "studio", reel_id: reelId } },
    ]);
});

test("One part fails: only that part is sent again and the upload completes", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  const counts = countParts(page);
  let failedOnce = false;
  await page.route(
    (url) => isPart(url.href),
    async (route) => {
      const part = new URL(route.request().url()).searchParams.get("partNumber");
      if (part === "2" && !failedOnce) {
        failedOnce = true;
        await route.abort();
        return;
      }
      await route.continue();
    },
  );
  await signIn(page, owner.email, baseURL!);
  await pickAndUpload(page);

  await expect(page).toHaveURL(REEL_URL, { timeout: 60_000 });
  const reelId = new URL(page.url()).pathname.split("/").pop()!;
  expect(failedOnce).toBe(true);
  expect(counts).toEqual({ 1: 1, 2: 2, 3: 1, 4: 1 });
  expect(await finished(reelId)).toEqual({
    reel: { status: "uploaded", source_bytes: 36700160 },
    jobs: ONE_JOB,
    sha256: footage.sha256,
  });
  await expect.poll(() => eventsNamed(events, "studio_footage_uploaded")).toHaveLength(1);
});

test("Reload resumes: after a reload the same file sends only the missing parts", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  const counts = countParts(page);
  // Part 3 never gets through before the reload (parts go one at a time, so
  // part 4 is never sent either).
  const held: Route[] = [];
  await page.route(
    (url) => isPart(url.href) && new URL(url.href).searchParams.get("partNumber") === "3",
    (route) => {
      held.push(route);
    },
  );
  await signIn(page, owner.email, baseURL!);
  await pickAndUpload(page);

  const row = await uploadingReel(owner.id);
  await expect
    .poll(async () =>
      (await storage.listUploadParts(row.source_key, { uploadId: row.source_upload_id }))?.map(
        (part) => part.partNumber,
      ),
    )
    .toEqual([1, 2]);
  await expect.poll(() => held.length).toBe(1);

  await page.reload();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const part of Object.keys(counts)) delete counts[Number(part)];

  await expect(page.getByTestId("upload-resume")).toHaveText(
    "An upload of footage-35mb.mp4 was interrupted. Pick the same file to resume.",
  );
  await pickAndUpload(page);

  await expect(page).toHaveURL(`${baseURL}/studio/reels/${row.id}`, { timeout: 60_000 });
  expect(counts).toEqual({ 3: 1, 4: 1 });
  expect(await finished(row.id)).toEqual({
    reel: { status: "uploaded", source_bytes: 36700160 },
    jobs: ONE_JOB,
    sha256: footage.sha256,
  });
  await expect
    .poll(() => eventsNamed(events, "studio_footage_uploaded"))
    .toEqual([
      { event: "studio_footage_uploaded", properties: { app: "studio", reel_id: row.id } },
    ]);
  // The record is gone once the upload finished.
  expect(await page.evaluate(() => localStorage.getItem("studio_upload_resume"))).toBeNull();
});

test("Ownership: another user and a signed-out caller cannot sign, list, complete or abort", async ({
  page,
  browser,
  baseURL,
  playwright,
}) => {
  await page.route(
    (url) => isPart(url.href),
    () => undefined,
  );
  await signIn(page, owner.email, baseURL!);
  await pickAndUpload(page);
  const row = await uploadingReel(owner.id);
  const base = `${baseURL}/studio/api/uploads/s3/multipart/${row.source_upload_id}`;
  const json = { "content-type": "application/json" };
  const complete = { parts: [{ PartNumber: 1, ETag: "0".repeat(32) }] };

  const context = await browser.newContext();
  try {
    const intruder = await context.newPage();
    await signIn(intruder, other.email, baseURL!);
    const asOther = intruder.request;
    expect((await asOther.get(`${base}/1`)).status()).toBe(404);
    expect((await asOther.get(base)).status()).toBe(404);
    expect(
      (await asOther.post(`${base}/complete`, { headers: json, data: complete })).status(),
    ).toBe(404);
    expect((await asOther.delete(base)).status()).toBe(404);
  } finally {
    await context.close();
  }

  const anonymous = await playwright.request.newContext();
  try {
    expect((await anonymous.get(`${base}/1`)).status()).toBe(401);
    expect((await anonymous.get(base)).status()).toBe(401);
    expect(
      (await anonymous.post(`${base}/complete`, { headers: json, data: complete })).status(),
    ).toBe(401);
    expect((await anonymous.delete(base)).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  const { data: reel } = await admin.from("reels").select("status").eq("id", row.id).single();
  expect(reel).toEqual({ status: "uploading" });
  expect(await storage.listUploadParts(row.source_key, { uploadId: row.source_upload_id })).toEqual(
    [],
  );
});

test("Cancel: the reel becomes failed, its parts are gone and no job is queued", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  await page.route(
    (url) => isPart(url.href),
    () => undefined,
  );
  await signIn(page, owner.email, baseURL!);
  await pickAndUpload(page);
  const row = await uploadingReel(owner.id);
  await expect(page.getByTestId("upload-progress")).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#upload-status")).toHaveText("Upload cancelled.");
  await expect
    .poll(async () => (await admin.from("reels").select("status").eq("id", row.id).single()).data)
    .toEqual({ status: "failed" });
  expect(
    await storage.listUploadParts(row.source_key, { uploadId: row.source_upload_id }),
  ).toBeNull();
  expect((await admin.from("jobs").select("id").eq("reel_id", row.id)).data).toEqual([]);
  expect(eventsNamed(events, "studio_footage_uploaded")).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("studio_upload_resume"))).toBeNull();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
