import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import {
  type DecideAnswer,
  type Edit,
  type HeadTrack,
  ISSEBYA,
  type Transcript,
  build,
  createMeasurer,
  editFromAnswer,
  soundHits,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signInLink,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import {
  PIPELINE_FIXTURES,
  readManifest,
  saveNextVersion,
  seedProcessedReel,
} from "../test-support/pipeline.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";
import {
  type Span,
  duration,
  extractFrame,
  integratedLoudness,
  onsets,
  scaleTo,
  ssim,
} from "./media.ts";

// The guardrail of section 4: the exported MP4 matches the live preview frame
// by frame, and its sound is the retimed source plus the clicks at their
// times. Real HyperFrames through the worker's `once`, on the owner's Mac.
const SSIM_BOUND = 0.95;
// The fixture reel is 2.67 s long, so the whole render is the 0 to 3 s span.
const TIMES = [0.5, 1.5, 2.5];
const LOUDNESS_LU = 0.5;
const ONSET_S = 0.02;
const ONE_CHROME_BYTES = 256 * 1024 * 1024;

const ROOT = new URL("../../../", import.meta.url);
const ANSWER = new URL("fixtures/decide/short-speech.json", ROOT);
const ASSETS = new URL("packages/edit/assets/", ROOT);
const CACHE_PREFIX = `tools-${crypto.randomUUID()}/`;
const MOCK_STORAGE = "/studio/api/e2e-storage-mock/";

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
const storedKeys: string[] = [];
let owner: { id: string; email: string };
let reelId: string;
let jobId: string;
let work: string;
let exported: string;
let edit: Edit;
let versionKey: string;
let transcript: Transcript;
let headTrack: HeadTrack;

async function fixtureJson<T>(url: URL): Promise<T> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  return JSON.parse(await readFile(url, "utf8")) as T;
}

const player = (page: Page) => page.locator("hyperframes-player");

async function openReel(page: Page, baseURL: string) {
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reelId}`);
  await expect(player(page)).toBeAttached();
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
}

// Seeks the paused player to `seconds`, waits until both videos show that
// frame and the fonts are loaded, and screenshots the player.
async function previewFrame(page: Page, seconds: number, out: string) {
  await player(page).evaluate((el, at) => {
    (el as unknown as { seek(time: number): void }).seek(at);
  }, seconds);
  await expect
    .poll(
      () =>
        player(page).evaluate(async (el, at) => {
          const host = el as unknown as { currentTime: number; iframeElement: HTMLIFrameElement };
          const doc = host.iframeElement.contentDocument;
          if (!doc || Math.abs(host.currentTime - at) > 0.02) return false;
          await doc.fonts.ready;
          return [...doc.querySelectorAll("video")].every(
            (video) => video.readyState >= 2 && !video.seeking,
          );
        }, seconds),
      { timeout: 15_000 },
    )
    .toBe(true);
  // Two frames for the compositor to paint what the videos now hold.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await player(page).screenshot({ path: out });
}

// The SSIM of the preview and the export at each time, both scaled to the
// screenshot's size.
async function scores(page: Page, label: string): Promise<number[]> {
  const box = await player(page).boundingBox();
  if (!box) throw new Error("player not shown");
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  const out: number[] = [];
  for (const seconds of TIMES) {
    const preview = join(work, `${label}-preview-${seconds}.png`);
    const frame = join(work, `export-${seconds}.png`);
    const previewScaled = join(work, `${label}-preview-${seconds}-scaled.png`);
    const frameScaled = join(work, `export-${seconds}-${width}x${height}.png`);
    await previewFrame(page, seconds, preview);
    await extractFrame(exported, seconds, frame);
    await scaleTo(preview, width, height, previewScaled);
    await scaleTo(frame, width, height, frameScaled);
    out.push(await ssim(previewScaled, frameScaled));
  }
  return out;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(20 * 60 * 1000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  work = await mkdtemp(join(tmpdir(), "preview-matches-export-"));
  owner = await createTestUser(admin, "export-tools");
  reelId = await insertReel(admin, {
    ownerId: owner.id,
    name: "short-speech.mp4",
    status: "uploaded",
  });
  const first = await seedProcessedReel(admin, storage, { prefix: CACHE_PREFIX, reelId });
  storedKeys.push(first.r2_key);
  for (const step of (await readManifest()).steps) {
    for (const file of step.files) {
      storedKeys.push(`${CACHE_PREFIX}cache/${step.name}/${step.fingerprint}/${file}`);
    }
  }
  transcript = await fixtureJson<Transcript>(new URL("retime/transcript.json", PIPELINE_FIXTURES));
  headTrack = await fixtureJson<HeadTrack>(
    new URL("head_track/head-track.json", PIPELINE_FIXTURES),
  );

  // The decide fixture's edit: it has a click, so the sound track is exercised.
  const [{ output }] = await fixtureJson<[{ output: DecideAnswer }]>(ANSWER);
  edit = editFromAnswer(output, first.inputs);
  const next = await saveNextVersion(admin, storage, { prefix: CACHE_PREFIX, reelId, edit });
  versionKey = next.r2_key;
  storedKeys.push(versionKey);

  const job = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, kind: "render", version_id: next.id })
    .select("id")
    .single();
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);
  jobId = job.data.id as string;

  // No E2E_MOCK_RENDER: the real HyperFrames renders.
  const worker = await runWorkerOnce(
    { R2_KEY_PREFIX: CACHE_PREFIX },
    { timeoutMs: 15 * 60 * 1000 },
  );
  if (worker.code !== 0) throw new Error(`worker failed:\n${worker.output}`);

  const { data, error } = await admin.from("exports").select("r2_key").eq("job_id", jobId).single();
  if (error || !data) throw new Error(`no export: ${error?.message}`);
  storedKeys.push(data.r2_key as string);
  exported = join(work, "export.mp4");
  if (!(await storage.getFile(data.r2_key as string, exported))) {
    throw new Error("export object missing");
  }
});

test.afterAll(async () => {
  for (const key of storedKeys) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
  if (work) await rm(work, { recursive: true, force: true });
});

test("the export matches the preview", async ({ page, baseURL }) => {
  await openReel(page, baseURL!);
  const matched = await scores(page, "same");
  console.log(`SSIM at ${TIMES.join(" / ")} s: ${matched.map((s) => s.toFixed(4)).join(" / ")}`);
  for (const score of matched) expect(score).toBeGreaterThanOrEqual(SSIM_BOUND);

  // Negative proof: the preview is served a copy of the edit with one caption
  // moved 60 px down. Nothing is stored, so no probe version exists.
  const fonts: Record<string, Uint8Array> = {};
  for (const [key, font] of Object.entries(ISSEBYA.fonts)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the preset's committed fonts
    fonts[key] = new Uint8Array(await readFile(new URL(font.file, ASSETS)));
  }
  const measurer = createMeasurer(fonts);
  let layout;
  try {
    ({ layout } = build({ edit, transcript, headTrack, preset: ISSEBYA, measurer }));
  } finally {
    measurer.close();
  }
  const shown = layout.find(
    (entry) => entry.track === "captions" && TIMES.some((t) => entry.start <= t && t < entry.end),
  );
  if (!shown) throw new Error("no caption is visible at the compared times");
  const moved = structuredClone(edit);
  const caption = moved.tracks.captions.find((item) => item.id === shown.id)!;
  caption.style = { ...caption.style, position: { x: shown.x, y: shown.y + 60 } };
  const pattern = `**${MOCK_STORAGE}${versionKey}*`;
  await page.route(pattern, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(moved) }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  const probed = await scores(page, "moved");
  await page.unroute(pattern);
  console.log(`SSIM with ${shown.id} moved 60 px: ${probed.map((s) => s.toFixed(4)).join(" / ")}`);
  expect(Math.min(...probed)).toBeLessThan(SSIM_BOUND);
});

test("the sound matches the sound track", async () => {
  const hits = soundHits(edit, transcript, ISSEBYA);
  expect(hits.length).toBeGreaterThan(0);
  const windows: Span[] = hits.map((hit) => ({ from: hit.at, to: hit.at + hit.duration + 0.02 }));
  const seconds = await duration(exported);
  const source = new URL("retime/source.mp4", PIPELINE_FIXTURES).pathname;

  const exportLoudness = await integratedLoudness(exported, { seconds, mute: windows });
  const sourceLoudness = await integratedLoudness(source, { seconds, mute: windows });
  console.log(`loudness: export ${exportLoudness} LUFS, source ${sourceLoudness} LUFS`);
  expect(Math.abs(exportLoudness - sourceLoudness)).toBeLessThanOrEqual(LOUDNESS_LU);

  const found = await onsets(exported, source, seconds);
  const errors = hits.map((hit) => Math.min(...found.map((at) => Math.abs(at - hit.at))));
  console.log(`click onset errors (ms): ${errors.map((e) => (e * 1000).toFixed(1)).join(", ")}`);
  for (const error of errors) expect(error).toBeLessThanOrEqual(ONSET_S);
  for (const at of found) {
    expect(
      windows.some(({ from, to }) => at >= from - ONSET_S && at <= to),
      `onset at ${at} s outside every click`,
    ).toBe(true);
  }
  // Kept for a failing run: the measured values beside the frames.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await writeFile(
    join(work, "sound.json"),
    JSON.stringify({ exportLoudness, sourceLoudness, found }),
  );
});

test("the render step sampled the whole process group", async () => {
  const { data, error } = await admin
    .from("steps")
    .select("status, peak_rss_bytes, summary")
    .eq("job_id", jobId)
    .eq("name", "render")
    .single();
  if (error || !data) throw new Error(`render step not read: ${error?.message}`);
  console.log(`render step: ${data.summary}, peak_rss_bytes ${data.peak_rss_bytes}`);
  expect(data.status).toBe("done");
  expect(data.peak_rss_bytes).toBeGreaterThan(ONE_CHROME_BYTES);
});
