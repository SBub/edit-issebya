import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeMultipart, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { eventsNamed, recordEvents } from "./events.ts";

// The multipart upload against the folder fake: 10 MiB parts, a failed part
// sent again on its own, a reload that continues from the parts storage holds,
// Cancel, and the 1 GiB browser limit.

const MIB = 1024 ** 2;
const CLIP_NAME = "clip-35mb.mp4";
const MOCK_ROUTE = "**/studio/api/e2e-storage-mock/**";
const RESUME_KEY = "studio-upload-resume";

const admin = localSupabaseAdmin();
const root = e2eStorageRoot(new URL(".", import.meta.url).pathname);
const storage = fakeStorage({ root, uploadUrlBase: "" });
const owners: string[] = [];
const createdKeys: string[] = [];
let folder: string;
let clipPath: string;
let clipBytes: number;
let clipHash: string;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test.beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "multipart-upload-"));
  // Four parts: 10, 10, 10 and 5 MiB.
  const clip = randomBytes(35 * MIB);
  clipPath = join(folder, CLIP_NAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the spec's temp dir
  await writeFile(clipPath, clip);
  clipBytes = clip.byteLength;
  clipHash = sha256(clip);
});

test.afterAll(async () => {
  for (const key of createdKeys) await storage.delete(key);
  // Cascade removes the reels and their queued jobs, so upload.spec.ts's
  // leftover-jobs guard stays green.
  for (const id of owners) await deleteTestUser(admin, id);
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function signIn(page: Page, baseURL: string | undefined) {
  const owner = await createTestUser(admin, "multipart");
  owners.push(owner.id);
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  return owner;
}

// Requests to the mock route, counted per part number, and list requests.
function countRequests(page: Page) {
  const parts: Record<number, number> = {};
  const counts = { parts, lists: 0 };
  page.on("request", (request) => {
    if (!request.url().includes("/studio/api/e2e-storage-mock/")) return;
    const url = new URL(request.url());
    const partNumber = url.searchParams.get("partNumber");
    if (request.method() === "PUT" && partNumber) {
      parts[Number(partNumber)] = (parts[Number(partNumber)] ?? 0) + 1;
    }
    if (request.method() === "GET" && url.searchParams.has("uploadId")) counts.lists += 1;
  });
  return counts;
}

// Every value the progress bar's aria-valuenow takes, kept on the window
// (client navigation keeps it).
async function recordProgress(page: Page) {
  await page.addInitScript(() => {
    const values: string[] = [];
    (window as unknown as { __progressValues: string[] }).__progressValues = values;
    new MutationObserver(() => {
      const value = document
        .querySelector('[data-testid="upload-progress"]')
        ?.getAttribute("aria-valuenow");
      if (value != null && values.at(-1) !== value) values.push(value);
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-valuenow"],
    });
  });
}

function progressValues(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __progressValues?: string[] }).__progressValues ?? [],
  );
}

// Holds the first request for this part number (never answered); `arrived`
// resolves once it comes in, every other request goes through. Wrapped in an
// object: an async function returning the bare promise would adopt it, and
// awaiting holdPart would then wait for a part the test has not sent yet.
async function holdPart(page: Page, partNumber: number): Promise<{ arrived: Promise<void> }> {
  let reached: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let held = false;
  await page.route(MOCK_ROUTE, async (route) => {
    const url = new URL(route.request().url());
    if (
      !held &&
      route.request().method() === "PUT" &&
      url.searchParams.get("partNumber") === String(partNumber)
    ) {
      held = true;
      reached();
      return;
    }
    await route.continue();
  });
  return { arrived };
}

async function readResume(page: Page): Promise<{ reelId: string; key: string; uploadId: string }> {
  const text = await page.evaluate((name) => window.localStorage.getItem(name), RESUME_KEY);
  expect(text).not.toBeNull();
  return JSON.parse(text!) as { reelId: string; key: string; uploadId: string };
}

function reelIdFrom(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop()!;
}

async function expectUploaded(reelId: string) {
  const { data: reel } = await admin
    .from("reels")
    .select("status, source_bytes, source_key, source_name")
    .eq("id", reelId)
    .single();
  expect(reel).toMatchObject({
    status: "uploaded",
    source_bytes: clipBytes,
    source_name: CLIP_NAME,
  });
  const key = reel!.source_key as string;
  createdKeys.push(key);
  const { data: jobs } = await admin.from("jobs").select("kind, status").eq("reel_id", reelId);
  expect(jobs).toEqual([{ kind: "process", status: "queued" }]);
  const stored = await storage.get(key);
  expect(stored?.byteLength).toBe(clipBytes);
  expect(sha256(stored!)).toBe(clipHash);
}

async function expectUploadedEventOnce(
  events: Awaited<ReturnType<typeof recordEvents>>,
  reelId: string,
) {
  await expect
    .poll(() => eventsNamed(events, "studio_footage_uploaded"))
    .toEqual([
      { event: "studio_footage_uploaded", properties: { app: "studio", reel_id: reelId } },
    ]);
}

const REEL_URL = /\/studio\/reels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe("multipart upload", () => {
  test.setTimeout(120_000);

  test("uploads in four parts", async ({ page, baseURL }) => {
    const events = await recordEvents(page);
    await recordProgress(page);
    const counts = countRequests(page);
    await signIn(page, baseURL);

    await page.getByLabel("Clip").setInputFiles(clipPath);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page).toHaveURL(REEL_URL, { timeout: 60_000 });
    const reelId = reelIdFrom(page);

    expect(counts.parts).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1 });
    expect(await progressValues(page)).toContain("100");
    await expectUploaded(reelId);
    await expectUploadedEventOnce(events, reelId);
    expect(await page.evaluate((name) => window.localStorage.getItem(name), RESUME_KEY)).toBeNull();
  });

  test("a failed part is sent again on its own", async ({ page, baseURL }) => {
    const events = await recordEvents(page);
    const counts = countRequests(page);
    let failed = false;
    await page.route(MOCK_ROUTE, async (route) => {
      const url = new URL(route.request().url());
      if (
        !failed &&
        route.request().method() === "PUT" &&
        url.searchParams.get("partNumber") === "2"
      ) {
        failed = true;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await signIn(page, baseURL);

    await page.getByLabel("Clip").setInputFiles(clipPath);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page).toHaveURL(REEL_URL, { timeout: 60_000 });
    const reelId = reelIdFrom(page);

    expect(counts.parts).toEqual({ 1: 1, 2: 2, 3: 1, 4: 1 });
    await expectUploaded(reelId);
    await expectUploadedEventOnce(events, reelId);
  });

  test("a reload resumes", async ({ page, baseURL }) => {
    const events = await recordEvents(page);
    const counts = countRequests(page);
    const owner = await signIn(page, baseURL);
    const { arrived } = await holdPart(page, 3);

    await page.getByLabel("Clip").setInputFiles(clipPath);
    await page.getByRole("button", { name: "Upload" }).click();
    await arrived;
    const before = await readResume(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.reload();

    await expect(page.getByTestId("upload-stopped")).toContainText(CLIP_NAME);
    const listsBefore = counts.lists;
    await page.getByLabel("Clip").setInputFiles(clipPath);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page).toHaveURL(REEL_URL, { timeout: 60_000 });
    const reelId = reelIdFrom(page);

    expect(reelId).toBe(before.reelId);
    expect(counts.parts[1]).toBe(1);
    expect(counts.parts[2]).toBe(1);
    expect(counts.parts[3]).toBeGreaterThanOrEqual(1);
    expect(counts.parts[4]).toBe(1);
    expect(counts.lists - listsBefore).toBeGreaterThanOrEqual(1);
    await expectUploaded(reelId);
    await expectUploadedEventOnce(events, reelId);
    const { data: reels } = await admin.from("reels").select("id").eq("owner_id", owner.id);
    expect(reels).toEqual([{ id: reelId }]);
    const { data: jobs } = await admin.from("jobs").select("id").eq("owner_id", owner.id);
    expect(jobs).toHaveLength(1);
  });

  test("Cancel marks the reel failed", async ({ page, baseURL }) => {
    const counts = countRequests(page);
    await signIn(page, baseURL);
    const { arrived } = await holdPart(page, 2);

    await page.getByLabel("Clip").setInputFiles(clipPath);
    await page.getByRole("button", { name: "Upload" }).click();
    await arrived;
    const record = await readResume(page);
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect
      .poll(async () => {
        const { data } = await admin
          .from("reels")
          .select("status")
          .eq("id", record.reelId)
          .single();
        return data?.status;
      })
      .toBe("failed");
    const { data: jobs } = await admin.from("jobs").select("id").eq("reel_id", record.reelId);
    expect(jobs).toEqual([]);
    await expect(fakeMultipart({ root }).listParts(record.key, record.uploadId)).rejects.toThrow(
      /no such upload/,
    );
    expect(await page.evaluate((name) => window.localStorage.getItem(name), RESUME_KEY)).toBeNull();
    expect(counts.parts[1]).toBe(1);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("a file over 1 GiB is refused in the browser", async ({ page, baseURL }) => {
    const owner = await signIn(page, baseURL);
    // A small file whose reported size is one byte over the limit.
    await page.evaluate(() => {
      const size = Object.getOwnPropertyDescriptor(Blob.prototype, "size")!;
      Object.defineProperty(File.prototype, "size", {
        configurable: true,
        get(this: File) {
          return this.name === "huge.mp4" ? 1024 ** 3 + 1 : (size.get!.call(this) as number);
        },
      });
    });
    await page.getByLabel("Clip").setInputFiles({
      name: "huge.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from([1, 2, 3]),
    });
    await page.getByRole("button", { name: "Upload" }).click();

    await expect(page.locator("#upload-status")).toHaveText("Pick a clip up to 1 GB.");
    const { data: reels } = await admin.from("reels").select("id").eq("owner_id", owner.id);
    expect(reels).toEqual([]);
  });
});
