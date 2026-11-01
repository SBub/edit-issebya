import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type Edit,
  ISSEBYA_PRESET,
  parseEdit,
  resolveTimeline,
  transcriptSchema,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// The worker's Node build of version 1 over fixtures/pipeline/.
const GOLDEN = new URL(
  "../../../packages/edit/src/testdata/golden/baseline-short-speech.html",
  import.meta.url,
);
const TRANSCRIPT = new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url);
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
const extraKeys: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "preview");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
});

test.afterAll(async () => {
  for (const key of [...(reel?.keys ?? []), ...extraKeys]) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

async function routeCdn(page: Page) {
  for (const { url, path } of CDN) {
    await page.route(url, (route) =>
      route.fulfill({ path, contentType: "application/javascript" }),
    );
  }
}

async function openReel(page: Page, baseURL: string) {
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  // The first open compiles the page, the builder and harfbuzzjs under `next dev`.
  await expect(page.locator('[data-preview="ready"]')).toBeVisible({ timeout: 30_000 });
}

function player(page: Page) {
  return page.locator("hyperframes-player");
}

function playerTime(page: Page): Promise<number> {
  return player(page).evaluate((el) => (el as unknown as { currentTime: number }).currentTime);
}

// The composition's frame, inside the player's open shadow root.
function composition(page: Page) {
  return page.frameLocator("hyperframes-player iframe");
}

// A range input set the way a drag sets it: the value, then an input event.
async function setPosition(page: Page, seconds: number) {
  await page.getByLabel("Position").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
}

// Samples the player's clock every 100 ms for two seconds.
async function clockFor2s(page: Page): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    samples.push(await playerTime(page));
    await page.waitForTimeout(100);
  }
  return samples;
}

async function fixtureTranscript() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  return transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
}

test("the reel opens with the player, the first caption, one open event and the worker's build", async ({
  page,
  baseURL,
}) => {
  await routeCdn(page);
  const events = await recordEvents(page);
  await openReel(page, baseURL!);
  await expect(player(page)).toBeVisible();

  await expect
    .poll(() => eventsNamed(events, "studio_preview_opened"))
    .toEqual([
      { event: "studio_preview_opened", properties: { app: "studio", reel_id: reel!.reelId } },
    ]);

  // The browser build of version 1 is the worker's Node build, byte for byte.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed golden
  const golden = await readFile(GOLDEN, "utf8");
  expect(await page.evaluate(() => window.__previewBuild)).toBe(golden);

  // The first caption is anchored on w0001 (0.038 s).
  const transcript = await fixtureTranscript();
  const first = transcript.words.find((word) => word.id === "w0001")!;
  await setPosition(page, first.start + 0.25);
  const caption = composition(page).locator("#cw0001");
  await expect(caption).toHaveText("This");
  await expect
    .poll(() => caption.evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeGreaterThan(0.5);
  // A second look at the page sends no second open event.
  expect(eventsNamed(events, "studio_preview_opened")).toHaveLength(1);
});

test("the clock waits until both videos can play, on play and after a seek", async ({
  page,
  baseURL,
}) => {
  await routeCdn(page);
  let releaseCutout!: () => void;
  const cutoutGate = new Promise<void>((resolve) => (releaseCutout = resolve));
  let releaseFootage!: () => void;
  const footageGate = new Promise<void>((resolve) => (releaseFootage = resolve));

  await page.route("**/cache/preview_copies/*/subject-preview.webm", async (route) => {
    await cutoutGate;
    await route.continue();
  });
  let footageRequests = 0;
  await page.route("**/cache/preview_copies/*/footage-preview.mp4", async (route) => {
    footageRequests += 1;
    if (footageRequests > 1) {
      await footageGate;
      await route.continue();
      return;
    }
    // The first quarter of the file only: the rest of the reel cannot play.
    const headers = Object.fromEntries(
      Object.entries(route.request().headers()).filter(([name]) => name.toLowerCase() !== "range"),
    );
    const full = await route.fetch({ headers });
    const body = await full.body();
    const quarter = body.subarray(0, Math.floor(body.byteLength / 4));
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
        "Content-Length": String(quarter.byteLength),
        "Content-Range": `bytes 0-${quarter.byteLength - 1}/${body.byteLength}`,
      },
      body: quarter,
    });
  });

  await openReel(page, baseURL!);
  await page.getByRole("button", { name: "Play" }).click();
  const held = await clockFor2s(page);
  for (const t of held) expect(Math.abs(t)).toBeLessThanOrEqual(0.001);
  await expect(page.getByRole("status").filter({ hasText: /^Loading$/ })).toBeVisible();

  releaseCutout();
  await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(0.2);

  // A seek while playing, to a point past the bytes served.
  const duration = await player(page).evaluate(
    (el) => (el as unknown as { duration: number }).duration,
  );
  const target = Math.round(duration * 0.8 * 100) / 100;
  await setPosition(page, target);
  const afterSeek = await clockFor2s(page);
  for (const t of afterSeek) expect(Math.abs(t - target)).toBeLessThanOrEqual(0.05);
  await expect(page.getByRole("status").filter({ hasText: /^Loading$/ })).toBeVisible();

  releaseFootage();
  await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(target + 0.1);
});

test("a new version rebuilds the preview live and its clicks are scheduled on their anchors", async ({
  page,
  baseURL,
}) => {
  await routeCdn(page);
  await openReel(page, baseURL!);
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  // Version 2: version 1 plus two clicks on w0002 and w0005.
  const transcript = await fixtureTranscript();
  const stored = await storage.get(reel!.versionKey);
  const json = JSON.parse(new TextDecoder().decode(stored!)) as {
    tracks: { sounds: unknown[] };
  };
  json.tracks.sounds = [
    {
      id: "click-a",
      sound: "click",
      start: { word: "w0002" },
      end: { word: "w0002", offset: 0.2 },
    },
    {
      id: "click-b",
      sound: "click",
      start: { word: "w0005" },
      end: { word: "w0005", offset: 0.2 },
    },
  ];
  const parsed = parseEdit(json, ISSEBYA_PRESET, transcript);
  expect(parsed.ok, parsed.ok ? "" : parsed.reasons.join("; ")).toBe(true);
  const edit = (parsed as { ok: true; edit: Edit }).edit;
  const v2 = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel!.reelId,
    edit,
    changeSummary: "two clicks",
  });
  extraKeys.push(v2.key);

  await expect(page.locator(`[data-preview-version="${v2.id}"][data-preview="ready"]`)).toBeVisible(
    { timeout: 30_000 },
  );
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
  // The clicks play through Web Audio only, never through the page's <audio>.
  await expect(composition(page).locator('audio[data-track-index="60"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__previewSounds?.starts.length ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(2);
  const sounds = (await page.evaluate(() => window.__previewSounds))!;
  // The first playback, from 0, scheduled both clicks.
  const { ctxTime, playhead } = sounds.playbacks[0]!;
  const resolved = resolveTimeline(edit, transcript);
  const starts = sounds.starts.slice(0, 2);
  expect(starts.map((start) => start.id)).toEqual(["click-a", "click-b"]);
  for (const start of starts) {
    const at = resolved.get(start.id)!.start;
    expect(Math.abs(start.when - (ctxTime - playhead) - at)).toBeLessThanOrEqual(0.01);
  }
});
