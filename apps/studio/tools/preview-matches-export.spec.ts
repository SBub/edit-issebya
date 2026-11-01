import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import {
  type DecideAnswer,
  type Edit,
  type HeadTrack,
  ISSEBYA,
  type LayoutEntry,
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
  type Region,
  type Span,
  crop,
  duration,
  extractFrame,
  frameRate,
  integratedLoudness,
  onsets,
  scaleTo,
  ssim,
} from "./media.ts";

// The guardrail of section 4: the exported MP4 matches the live preview frame
// by frame, and its sound is the retimed source plus the clicks at their
// times. Real HyperFrames through the worker's `once`, on the owner's Mac.
// Lowered from 0.95 on measured evidence. With the frames compared at the same
// index and at the export's own raster, every text edge in the preview still
// sits 1 to 1.5 frame px higher than in the export (the title at y 300 and
// settled captions alike; horizontal edges match), which is the two Chromes'
// glyph rasterisation, not the edit. On a 177x158 caption region that alone
// scores 0.93 to 0.97 (0.9478 / 0.9690 / 0.9305 at 0.5 / 1.5 / 2.5 s), while
// the whole frame holds 0.99 and the probe's moved caption scores far below.
const SSIM_BOUND = 0.92;
// The fixture reel is 2.67 s long, so the whole render is the 0 to 3 s span.
// Each time falls inside a caption transition (GSAP appear 0.18 s with a 12 px
// rise, fade 0.15 s): `c-w0004` "short" is 33 ms into its rise at 0.5 s,
// `c-w0007` "for" 143 ms into its rise at 1.5 s, `c-w0010` "studio" 45 ms into
// its fade at 2.5 s. So the comparison is frame exact: the export's frame
// round(t * fps) + FRAME_OFFSET, selected by index, and the player seeked to
// that frame's time. Measured region scores against export frames n - 1, n and
// n + 1: 0.8353 / 0.9478 / 0.8924 at 0.5 s, 0.9151 / 0.9690 / 0.9634 at 1.5 s,
// 0.9055 / 0.9305 / 0.9006 at 2.5 s; frame n is best at every time, so no
// offset (the `-ss` seek had picked frame n too: 0.9226 / 0.9613 / 0.9153 at
// the old 1152 px scale).
const TIMES = [0.5, 1.5, 2.5];
const FRAME_OFFSET = 0;
const LOUDNESS_LU = 0.5;
const ONSET_S = 0.02;
const ONE_CHROME_BYTES = 256 * 1024 * 1024;
// The negative proof moves one caption this far down; its region is padded
// by PAD on every side (frame pixels).
const SHIFT = 60;
const PAD = 24;

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

// Where a caption sits before and after the probe moves it: its laid-out box
// and the same box SHIFT lower, padded and kept inside the frame (frame pixels).
function captionRegion(entry: LayoutEntry): Region {
  const { frame } = ISSEBYA;
  const x = Math.max(0, entry.x - PAD);
  const y = Math.max(0, entry.y - PAD);
  const right = Math.min(frame.width, entry.x + entry.width + PAD);
  const bottom = Math.min(frame.height, entry.y + entry.height + SHIFT + PAD);
  return { x, y, width: right - x, height: bottom - y };
}

// The region mapped to an image of `width` x `height`: at least 8 px each way
// (ffmpeg's ssim needs a few pixels) and inside the image.
function scaledRegion(region: Region, width: number, height: number): Region {
  const k = width / ISSEBYA.frame.width;
  const w = Math.min(width, Math.max(8, Math.round(region.width * k)));
  const h = Math.min(height, Math.max(8, Math.round(region.height * k)));
  const x = Math.min(width - w, Math.floor(region.x * k));
  const y = Math.min(height - h, Math.floor(region.y * k));
  return { x, y, width: w, height: h };
}

// The SSIM of the preview and the export at each time, both at the export's
// own frame size: on the whole frame, which proves the frame matches, and on
// the caption's region, which is what can see a caption that is a small part
// of the frame, so the negative proof stands on it.
async function scores(
  page: Page,
  label: string,
  region: Region,
): Promise<{ whole: number[]; region: number[] }> {
  const { frame } = ISSEBYA;
  const box = await player(page).boundingBox();
  if (!box) throw new Error("player not shown");
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  // The region is mapped in frame pixels, which is only right when the
  // screenshot is the whole frame: the box must be the 9:16 video area (within
  // 1 CSS px), with no letterbox, drawn at the export's own size.
  expect(Math.abs(box.width * 16 - box.height * 9)).toBeLessThanOrEqual(16);
  const width = Math.round(box.width * ratio);
  const height = Math.round(box.height * ratio);
  expect(width).toBe(frame.width);
  const shot: Region = { x: 0, y: 0, width, height };
  const cut = scaledRegion(region, frame.width, frame.height);
  const fps = await frameRate(exported);
  const out = { whole: [] as number[], region: [] as number[] };
  for (const seconds of TIMES) {
    const index = Math.round(seconds * fps) + FRAME_OFFSET;
    const at = index / fps;
    const preview = join(work, `${label}-preview-${seconds}.png`);
    const exportFrame = join(work, `export-${seconds}.png`);
    const previewBox = join(work, `${label}-preview-${seconds}-box.png`);
    const previewScaled = join(work, `${label}-preview-${seconds}-scaled.png`);
    const previewRegion = join(work, `${label}-preview-${seconds}-region.png`);
    const frameRegion = join(work, `export-${seconds}-region.png`);
    await previewFrame(page, at, preview);
    await extractFrame(exported, index, exportFrame);
    // An element screenshot is rounded out to whole CSS px (683 for a
    // 682.66 px box), so its last rows are past the frame: cut them off
    // rather than squeeze them into the frame.
    await crop(preview, shot, previewBox);
    await scaleTo(previewBox, frame.width, frame.height, previewScaled);
    await crop(previewScaled, cut, previewRegion);
    await crop(exportFrame, cut, frameRegion);
    out.whole.push(await ssim(previewScaled, exportFrame));
    out.region.push(await ssim(previewRegion, frameRegion));
  }
  return out;
}

const fixed = (values: number[]) => values.map((s) => s.toFixed(4)).join(" / ");

test.describe.configure({ mode: "serial" });
// The player is 384 px wide at the config's viewport (`max-w-sm`). At device
// scale 1 its captions are drawn at a third of the export's size, where
// hinting makes them bolder and a pixel or two off: the same word in the same
// place scored 0.90 on its caption region (0.8974 at 2.5 s). At 3 (1152 px)
// the export had to be upscaled to the preview's size, which blurred it
// (0.9153 at 2.5 s). At 1080 / 384 the preview draws the frame at exactly the
// export's 1080 px, so neither image is resampled across sizes.
test.use({ deviceScaleFactor: ISSEBYA.frame.width / 384 });

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
  // The caption the negative proof moves, and the region it occupies.
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
  const region = captionRegion(shown);

  await openReel(page, baseURL!);
  const matched = await scores(page, "same", region);
  console.log(
    `SSIM at ${TIMES.join(" / ")} s: whole ${fixed(matched.whole)}, caption region ${fixed(matched.region)}`,
  );
  for (const score of [...matched.whole, ...matched.region]) {
    expect(score).toBeGreaterThanOrEqual(SSIM_BOUND);
  }

  // Negative proof: the preview is served a copy of the edit with that caption
  // moved SHIFT px down. Nothing is stored, so no probe version exists.
  const moved = structuredClone(edit);
  const caption = moved.tracks.captions.find((item) => item.id === shown.id)!;
  caption.style = { ...caption.style, position: { x: shown.x, y: shown.y + SHIFT } };
  const pattern = `**${MOCK_STORAGE}${versionKey}*`;
  await page.route(pattern, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(moved) }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  const probed = await scores(page, "moved", region);
  await page.unroute(pattern);
  console.log(
    `SSIM with ${shown.id} moved ${SHIFT} px: whole ${fixed(probed.whole)}, caption region ${fixed(probed.region)}`,
  );
  expect(Math.min(...probed.whole, ...probed.region)).toBeLessThan(SSIM_BOUND);
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
