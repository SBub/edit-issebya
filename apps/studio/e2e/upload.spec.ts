import { readFile, stat } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { eventsNamed, recordEvents } from "./events.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

const CLIP = new URL("../../../fixtures/footage/short-speech.mp4", import.meta.url).pathname;
// Every step's outputs for the clip, under their fingerprints
// (`yarn workspace @edit-issebya/worker fixtures:pipeline`).
const PIPELINE_FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);
// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let sourceKey: string | null = null;
const seededKeys: string[] = [];

interface PipelineManifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

// Stores every committed step output at `<prefix>cache/<step>/<fingerprint>/<file>`,
// so the worker finds each step's outputs and spawns no tool.
async function seedPipelineCache() {
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("manifest.json", PIPELINE_FIXTURES), "utf8"),
  ) as PipelineManifest;
  for (const step of manifest.steps) {
    for (const file of step.files) {
      const key = `${CACHE_PREFIX}cache/${step.name}/${step.fingerprint}/${file}`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
      const body = await readFile(new URL(`${step.name}/${file}`, PIPELINE_FIXTURES));
      await storage.put(key, new Uint8Array(body));
      seededKeys.push(key);
    }
  }
}

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
  for (const key of seededKeys) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("an uploaded clip goes through every pipeline step and the page updates live", async ({
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
  expect(await storage.head(sourceKey)).toMatchObject({ bytes: clipBytes });

  await expect(page.locator('[data-realtime="ready"]')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  await seedPipelineCache();
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  await expect(page.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  // Every step's outputs were already stored: each is a hit, nothing ran.
  await expect(page.getByTestId("step-line")).toHaveText(
    [
      "convert: footage converted, reused",
      "transcribe: transcribed, reused",
      "retime: retimed, reused",
      "remove_background: background removed, reused",
      "head_track: head tracked, reused",
      "preview_copies: preview copies made, reused",
    ],
    { timeout: 10_000 },
  );
  // A hit: wall time only, the other measurements null.
  const { data: steps } = await admin
    .from("steps")
    .select("name, status, cache_hit, wall_ms, cpu_ms, peak_rss_bytes, bytes_in, bytes_out")
    .eq("reel_id", reelId)
    .order("started_at");
  const hit = (name: string) => ({
    name,
    status: "skipped",
    cache_hit: true,
    wall_ms: expect.any(Number),
    cpu_ms: null,
    peak_rss_bytes: null,
    bytes_in: null,
    bytes_out: null,
  });
  expect(steps).toEqual([
    hit("convert"),
    hit("transcribe"),
    hit("retime"),
    hit("remove_background"),
    hit("head_track"),
    hit("preview_copies"),
  ]);
  for (const step of steps!) expect(step.wall_ms).toBeGreaterThanOrEqual(0);
  await expect(page.getByTestId("reel-status")).toHaveText("processed", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
  expect(posthogRequests).toEqual([]);
});
