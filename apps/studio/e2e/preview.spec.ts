import { readFile } from "node:fs/promises";
import { type Page, type Route, expect, test } from "@playwright/test";
import {
  type Edit,
  type HeadTrack,
  type Transcript,
  ISSEBYA,
  build,
  createMeasurer,
  parseEdit,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { PIPELINE_FIXTURES, saveNextVersion, seedPipelineCache } from "../test-support/pipeline.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

const CLIP = new URL("../../../fixtures/footage/short-speech.mp4", import.meta.url);
const ASSETS = new URL("../../../packages/edit/assets/", import.meta.url);
// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
const storedKeys: string[] = [];
let owner: { id: string; email: string };
let reelId: string;
let transcript: Transcript;
let headTrack: HeadTrack;
let version1: Edit;

async function fixtureJson<T>(path: string): Promise<T> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  return JSON.parse(await readFile(new URL(path, PIPELINE_FIXTURES), "utf8")) as T;
}

async function readEdit(key: string): Promise<Edit> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`version object missing: ${key}`);
  return parseEdit(new TextDecoder().decode(bytes), { transcript, preset: ISSEBYA });
}

async function currentVersion(): Promise<{ id: string; r2_key: string }> {
  const { data: reel } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reelId)
    .single();
  const { data: version, error } = await admin
    .from("versions")
    .select("id, r2_key")
    .eq("id", reel!.current_version_id)
    .single();
  if (error || !version) throw new Error(`no current version: ${error?.message}`);
  return version as { id: string; r2_key: string };
}

function wordStart(id: string): number {
  return transcript.words.find((word) => word.id === id)!.start;
}

// The clicks version 2 adds: two words at least `minSoundGap` apart.
const CLICKS = [
  { id: "click-a", word: "w0002" },
  { id: "click-b", word: "w0006" },
];

const player = (page: Page) => page.locator("hyperframes-player");

function playerTime(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (document.querySelector("hyperframes-player") as unknown as { currentTime: number })
        .currentTime,
  );
}

async function openReel(page: Page, baseURL: string) {
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(player(page)).toBeAttached();
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 20_000 });
}

// Holds every request matching `pattern` until `release` is called.
async function holdRequests(page: Page, pattern: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let requested = false;
  await page.route(pattern, async (route: Route) => {
    requested = true;
    await released;
    await route.continue();
  });
  return { release, wasRequested: () => requested };
}

// Serves the first `fraction` of every file matching `pattern` as a 206
// partial response and holds every request for a later byte until `release`
// is called. Each request starting inside the served part gets the part from
// its start (the composition's video and the player's parent-frame proxy both
// ask for `bytes=0-`).
async function serveFirstPart(page: Page, pattern: string, fraction: number) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(pattern, async (route: Route) => {
    const from = Number(/bytes=(\d+)-/.exec(route.request().headers().range ?? "")?.[1] ?? 0);
    const response = await route.fetch({
      headers: { ...route.request().headers(), range: "bytes=0-" },
    });
    const body = await response.body();
    const total = Number(response.headers()["content-range"]?.split("/")[1] ?? body.byteLength);
    const last = Math.floor(total * fraction) - 1;
    if (from > last) {
      await released;
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 206,
      headers: {
        "Content-Range": `bytes ${from}-${last}/${total}`,
        "Content-Length": String(last + 1 - from),
        "Accept-Ranges": "bytes",
        "Content-Type": response.headers()["content-type"] ?? "video/mp4",
      },
      body: body.subarray(from, last + 1),
    });
  });
  return { release };
}

// What both videos report at the moment the player fires `play`.
type PlayReadiness = {
  id: string;
  readyState: number;
  seeking: boolean;
  currentTime: number;
  clock: number;
};

// Records every video's readiness at each of the player's `play` events. The
// listener is on `window` in the capture phase, which sees the player's
// non-bubbling event.
async function recordPlayReadiness(page: Page) {
  await page.addInitScript(() => {
    const records: PlayReadiness[] = [];
    (window as unknown as { __playReadiness: PlayReadiness[] }).__playReadiness = records;
    window.addEventListener(
      "play",
      (event) => {
        const target = event.target as Element;
        if (target.tagName !== "HYPERFRAMES-PLAYER") return;
        const el = target as unknown as {
          currentTime: number;
          iframeElement: HTMLIFrameElement | null;
        };
        const doc = el.iframeElement?.contentDocument;
        for (const id of ["footage", "cutout"]) {
          const video = doc?.getElementById(id) as HTMLVideoElement | null;
          if (!video) continue;
          records.push({
            id,
            readyState: video.readyState,
            seeking: video.seeking,
            currentTime: video.currentTime,
            clock: el.currentTime,
          });
        }
      },
      true,
    );
  });
}

// Every video could play from the clock's time when the clock started (the
// thresholds of `canPlayFrom` in src/lib/media-ready.ts).
function playableAtClock(records: PlayReadiness[]): boolean {
  return (
    records.length > 0 &&
    records.every(
      (record) =>
        record.readyState >= 3 &&
        !record.seeking &&
        Math.abs(record.currentTime - record.clock) <= 0.25,
    )
  );
}

// Samples the player's time for `ms` and returns the furthest it moved from `at`.
async function drift(page: Page, at: number, ms: number): Promise<number> {
  let furthest = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    furthest = Math.max(furthest, Math.abs((await playerTime(page)) - at));
    await page.waitForTimeout(100);
  }
  return furthest;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  transcript = await fixtureJson<Transcript>("retime/transcript.json");
  headTrack = await fixtureJson<HeadTrack>("head_track/head-track.json");
  owner = await createTestUser(admin, "preview");
  reelId = await insertReel(admin, {
    ownerId: owner.id,
    name: "short-speech.mp4",
    status: "uploaded",
  });

  // The uploaded clip, as the upload form leaves it, and every step's outputs.
  const sourceKey = `${CACHE_PREFIX}reels/${reelId}/source/original.mp4`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  const clip = new Uint8Array(await readFile(CLIP));
  await storage.put(sourceKey, clip);
  storedKeys.push(sourceKey, ...(await seedPipelineCache(storage, CACHE_PREFIX)));
  const reel = await admin
    .from("reels")
    .update({ source_key: sourceKey, source_bytes: clip.byteLength })
    .eq("id", reelId);
  if (reel.error) throw new Error(`reel not updated: ${reel.error.message}`);
  const job = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, kind: "process" });
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);

  // Every step is a hit; version 1 is saved and the preview copies recorded.
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  if (worker.code !== 0) throw new Error(`worker failed:\n${worker.output}`);
  const v1 = await currentVersion();
  storedKeys.push(v1.r2_key);
  version1 = await readEdit(v1.r2_key);
});

test.afterAll(async () => {
  for (const key of storedKeys) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("the player shows the current version with its first caption at its time", async ({
  page,
  baseURL,
}) => {
  await openReel(page, baseURL!);
  const first = version1.tracks.captions[0]!;
  const at = wordStart((first.start as { word: string }).word) + ISSEBYA.caption.appear;
  await page.getByLabel("Position").fill(at.toFixed(2));

  const caption = page.frameLocator("hyperframes-player iframe").locator(`#${first.id}`);
  await expect(caption).toHaveText(first.text);
  await expect
    .poll(() => caption.evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeGreaterThan(0.9);
});

test("the clock waits until both videos can play, at start and after a seek into unbuffered footage", async ({
  page,
  baseURL,
}) => {
  // On a fresh load the player's own first-frame wait holds the clock here too.
  const cutout = await holdRequests(page, "**/cache/preview_copies/**/subject.webm");
  await openReel(page, baseURL!);
  expect(cutout.wasRequested()).toBe(true);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByText("Loading", { exact: true })).toBeVisible();
  expect(await drift(page, 0, 1500)).toBeLessThanOrEqual(0.05);
  await expect(page.getByText("Loading", { exact: true })).toBeVisible();
  cutout.release();
  await expect.poll(() => playerTime(page), { timeout: 5000 }).toBeGreaterThan(0.3);

  // A fresh page with most of the footage served and its tail held. Chromium
  // reports no metadata until it has read the first 32 KiB of the 43 KB copy
  // (about 2 s of its 2.7 s), so the player's first-frame wait settles only
  // with 80% served; the seek goes just past what is buffered. That wait runs
  // once per load, so from here only the studio's gate can hold the clock.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await recordPlayReadiness(page);
  const footage = await serveFirstPart(page, "**/cache/preview_copies/**/footage.mp4", 0.8);
  await openReel(page, baseURL!);
  await expect
    .poll(() =>
      player(page).evaluate((el) => (el as unknown as { assetsReady: boolean }).assetsReady),
    )
    .toBe(true);
  const buffered = await player(page).evaluate((el) => {
    const doc = (el as unknown as { iframeElement: HTMLIFrameElement }).iframeElement
      .contentDocument;
    const video = doc!.getElementById("footage") as HTMLVideoElement;
    return video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0;
  });
  const at = Number((buffered + 0.15).toFixed(2));
  const duration = await player(page).evaluate(
    (el) => (el as unknown as { duration: number }).duration,
  );
  // Room to play on past the seek, or the case proves nothing.
  expect(at + 0.3).toBeLessThan(duration);
  await page.getByLabel("Position").fill(String(at));
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByText("Loading", { exact: true })).toBeVisible();
  expect(await drift(page, at, 1500)).toBeLessThanOrEqual(0.05);
  footage.release();
  await expect.poll(() => playerTime(page), { timeout: 5000 }).toBeGreaterThan(at + 0.2);
  const readiness = () =>
    page.evaluate(
      () => (window as unknown as { __playReadiness: PlayReadiness[] }).__playReadiness,
    );
  await expect.poll(async () => (await readiness()).length).toBeGreaterThan(0);
  const records = await readiness();
  expect(playableAtClock(records), JSON.stringify(records)).toBe(true);
});

test("a new current version rebuilds the preview without a reload, byte for byte the Node build, with one event", async ({
  page,
  baseURL,
}) => {
  const events = await recordEvents(page);
  await openReel(page, baseURL!);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible();
  const v1 = await currentVersion();
  await expect.poll(() => page.evaluate(() => window.__preview?.versionId)).toBe(v1.id);
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  // Version 2: version 1 plus two clicks.
  const edit: Edit = {
    ...version1,
    tracks: {
      ...version1.tracks,
      sounds: CLICKS.map(({ id, word }) => ({
        id,
        sound: "click",
        start: { word },
        end: { word, offset: ISSEBYA.sounds.click!.duration },
      })),
    },
  };
  const v2 = await saveNextVersion(admin, storage, { prefix: CACHE_PREFIX, reelId, edit });
  storedKeys.push(v2.r2_key);

  await expect
    .poll(() => page.evaluate(() => window.__preview?.versionId), { timeout: 15_000 })
    .toBe(v2.id);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );

  // The worker's build path: font bytes read from disk.
  const fonts: Record<string, Uint8Array> = {};
  for (const [key, font] of Object.entries(ISSEBYA.fonts)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the preset's own font files
    fonts[key] = new Uint8Array(await readFile(new URL(font.file, ASSETS)));
  }
  const measurer = createMeasurer(fonts);
  const node = build({
    edit: await readEdit(v2.r2_key),
    transcript,
    headTrack,
    preset: ISSEBYA,
    measurer,
  });
  measurer.close();
  expect(await page.evaluate(() => window.__preview?.html)).toBe(node.html);

  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 20_000 });
  expect(eventsNamed(events, "studio_preview_opened")).toEqual([
    { event: "studio_preview_opened", properties: { app: "studio", reel_id: reelId } },
  ]);
});

test("the clicks are scheduled at their word's time from the start of playback", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    window.__scheduledSounds = [];
  });
  await openReel(page, baseURL!);
  await page.getByRole("button", { name: "Play" }).click();

  type Started = { id: string; when: number; contextTime: number; playerTime: number };
  const started = async () =>
    ((await page.evaluate(() => window.__scheduledSounds ?? [])) as Started[]).filter(
      (entry) => "when" in entry,
    );
  await expect
    .poll(async () => (await started()).map((entry) => entry.id))
    .toEqual(CLICKS.map((click) => click.id));
  for (const entry of await started()) {
    const word = CLICKS.find((click) => click.id === entry.id)!.word;
    expect(
      Math.abs(entry.when - entry.contextTime + entry.playerTime - wordStart(word)),
    ).toBeLessThanOrEqual(0.01);
  }

  await page.getByRole("button", { name: "Pause" }).click();
  const stopped = (await page.evaluate(() => window.__scheduledSounds ?? []))
    .filter((entry) => "stopped" in entry)
    .map((entry) => entry.id);
  // The second click was still ahead when playback paused.
  expect(stopped).toContain("click-b");
});
