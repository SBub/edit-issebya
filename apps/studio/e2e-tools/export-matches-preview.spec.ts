import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Edit,
  ISSEBYA_PRESET,
  parseEdit,
  questionShownAt,
  resolveTimeline,
  transcriptSchema,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import {
  type Crop,
  extractFrame,
  pngSize,
  scaledImage,
  softenedPhoto,
  ssim,
} from "../test-support/frames.ts";
import { behindVisualAnswerScript, behindWordAnswerScript } from "../test-support/ai-script.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { SAMPLE_PHOTO, type SeededPhoto, seedReadyPhoto } from "../test-support/photos.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { seekOnRuler } from "../test-support/ruler.ts";
import { questionOf, withNumberedTransition, withQuestion } from "../test-support/transitions.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The guardrail: what the owner downloads is what the preview showed. The
// studio's live preview and the real exported MP4 are captured at the same
// moments and compared with ffmpeg's SSIM; text moved by 60 px must fall
// below the bound, so the comparison is proven sensitive. Real HyperFrames
// through the worker's `once`: the owner's Mac only, never CI.
// The bound started at 0.95 and was raised with measured evidence (never below 0.9): the guardrail
// scored 0.995673, 0.995609 and 0.997499 at 0.5, 1.5 and 2.5 s; the 60 px probe scored 0.995673,
// 0.982028 and 0.994654. 0.99 sat between the probe minimum and the guardrail minimum.
// The one-screen reel layout shrank the preview to 398x706, and both sets dropped: the guardrail
// scored 0.988583, 0.989767 and 0.988849; the probe 0.988583, 0.975669 and 0.985728. 0.982 sits
// near the middle of the new gap (probe minimum 0.975669, guardrail minimum 0.988583).
// Most of that loss was the measurement: the capture was the player element, a fraction of a pixel
// wider or taller than the composition it letterboxes, and the export was stretched to it; and
// ffmpeg's default yuv420p to RGB scale rippled every colour edge. Captured as the composition's own
// box, with the export cropped to the same area and scaled with full chroma, the guardrail scored
// 0.998655, 0.998293 and 0.998843, its probe 0.998655, 0.983808 and 0.995779, the photo behind the
// speaker 0.987437, 0.991179 and 0.99071, and its probe 0.923527, 0.937396 and 0.926636. The bound
// was raised to 0.9855, near the middle of the gap between the highest probe minimum (0.983808) and
// the lowest guardrail score (0.987437).
// One big word behind the speaker then scored 0.983279, 0.986733 and 0.986025. Its glyphs sat in
// the same place to the pixel and the loss was luma, not chroma (over the word's box Y 0.929059, U
// 0.992416, V 0.979932 at 0.5 s; the rest of the frame 0.998+): the preview's word was brighter at
// every edge. The preview rasterised the 400 px word at the player's 0.35 scale with the browser's
// text anti-aliasing, while the export rasterises it at 1080 px and is scaled down by ffmpeg.
// Captured at device scale 3 (about the composition's own size) and scaled down with the export
// frame's flags, the word scored 0.998661, 0.999108 and 0.999378 (word box Y 0.999684 at 0.5 s), the
// guardrail 0.999225, 0.999037 and 0.999345, its probe 0.999225, 0.983714 and 0.99612, the photo
// 0.995645, 0.99658 and 0.997241, and its probe 0.920737, 0.934469 and 0.922146. Both probes stay
// below 0.9855, so the bound stays.
const PREVIEW_EXPORT_SSIM_BOUND = 0.9855;
const MOMENTS = [0.5, 1.5, 2.5];
// The preview is captured at this device scale, so the composition (shown at
// about 0.35 of its 1080 px) is rasterised at about its own size, like the
// export, and then scaled down with the export frame's flags.
const CAPTURE_SCALE = 3;
const PROBE_MOMENT = 1.5;
const PROBE_SHIFT_PX = 60;
const RENDER_TIMEOUT_MS = 10 * 60_000;
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const TRANSCRIPT = fileURLToPath(
  new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url),
);
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
let dir: string;
let page: Page;
const written = new Set<string>();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(5 * 60_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(`claimable jobs already on the local stack: ${leftover.join(", ")}`);
  }
  owner = await createTestUser(admin, "export-guardrail");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  for (const key of reel.keys) written.add(key);
  dir = await mkdtemp(join(tmpdir(), "export-guardrail-"));
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
    deviceScaleFactor: CAPTURE_SCALE,
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
  if (reel) {
    const { data } = await admin.from("exports").select("r2_key").eq("reel_id", reel.reelId);
    for (const row of (data ?? []) as { r2_key: string }[]) written.add(row.r2_key);
  }
  for (const key of written) await storage.delete(key);
  if (dir) await rm(dir, { recursive: true, force: true });
  // The cascade removes the reel, its jobs, versions (the probe's included) and exports.
  if (owner) await deleteTestUser(admin, owner.id);
});

async function transcript() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  return transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
}

async function storedEdit(key: string): Promise<Edit> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`no edit at ${key}`);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(bytes)),
    ISSEBYA_PRESET,
    await transcript(),
  );
  if (!parsed.ok) throw new Error(`stored edit refused: ${parsed.reasons.join("; ")}`);
  return parsed.edit;
}

// Version 2's choices with a LIST placed by the layout engine (its layer
// crossing 1.5 s, carrying its two text levels),
// plus one accent before it and one click: every kind of layer the export
// must match.
async function guardrailEdit(base: Edit): Promise<Edit> {
  // The accent goes in the answer, so the engine places it (a raw overlay has
  // no position and the build refuses it). Before the transition comes in:
  // nothing else shows during one.
  const edit = await withNumberedTransition(base, await transcript(), [
    { from: "w0001", to: "w0001" },
  ]);
  edit.tracks.sounds.push({
    id: "click-guard",
    sound: "click",
    start: { word: "w0009" },
    end: { word: "w0009", offset: 0.23 },
  });
  return edit;
}

async function saveVersionOf(edit: Edit, changeSummary: string) {
  const saved = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel!.reelId,
    edit,
    changeSummary,
  });
  written.add(saved.key);
  return saved;
}

function composition() {
  return page.frameLocator("hyperframes-player iframe");
}

async function openPreview(versionId: string) {
  await expect(
    page.locator(`[data-preview-version="${versionId}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
}

// Seeks with a click on the ruler, then waits until every video in the frame has
// finished seeking to that moment with a frame decoded, and two animation
// frames have painted.
async function seekTo(seconds: number) {
  await seekOnRuler(page, seconds);
  await expect
    .poll(
      () =>
        composition()
          .locator("body")
          .evaluate((body, t) => {
            // Every video playing at t, at its own media time (a cut-out's
            // footage copies and masks included).
            const videos = [
              ...body.ownerDocument.querySelectorAll<HTMLVideoElement>("video[data-start]"),
            ].filter((video) => {
              const start = Number(video.dataset.start);
              return t >= start && t < start + Number(video.dataset.duration);
            });
            return (
              videos.length > 0 &&
              videos.every((video) => {
                const at = t - Number(video.dataset.start) + Number(video.dataset.mediaStart ?? 0);
                return (
                  !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - at) < 0.05
                );
              })
            );
          }, seconds),
      { timeout: 30_000 },
    )
    .toBe(true);
  await composition()
    .locator("body")
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
}

// A preview capture: the PNG, and the same area in the export's pixels.
interface Capture {
  file: string;
  crop: Crop;
}

// The composition's own box: the player scales the 1080x1920 iframe to fit
// its element and centres it, so the box is a fraction of a pixel narrower or
// shorter than the element (at 376x666, 374.6 px wide). Clipped inward to
// whole pixels, with the same area in the export's pixels, so the export is
// never stretched to the element's shape.
async function compositionClip() {
  const iframe = page.locator("hyperframes-player iframe");
  const box = await iframe.boundingBox();
  if (!box) throw new Error("no composition on the page");
  const naturalWidth = await iframe.evaluate((el) => (el as HTMLElement).offsetWidth);
  const x = Math.ceil(box.x);
  const y = Math.ceil(box.y);
  const clip = {
    x,
    y,
    width: Math.floor(box.x + box.width) - x,
    height: Math.floor(box.y + box.height) - y,
  };
  const scale = naturalWidth / box.width;
  const crop = {
    x: Math.round((x - box.x) * scale),
    y: Math.round((y - box.y) * scale),
    width: Math.round(clip.width * scale),
    height: Math.round(clip.height * scale),
  };
  return { clip, crop };
}

// The composition at each moment, as PNG files.
async function capturePreview(name: string, moments = MOMENTS): Promise<Capture[]> {
  const captures: Capture[] = [];
  for (const t of moments) {
    await seekTo(t);
    const file = join(dir, `${name}-preview-${t}.png`);
    const raw = join(dir, `${name}-preview-${t}-x${CAPTURE_SCALE}.png`);
    const { clip, crop } = await compositionClip();
    await page.screenshot({ path: raw, clip });
    await scaledImage(raw, clip.width, clip.height, file);
    captures.push({ file, crop });
  }
  return captures;
}

// Presses Export, runs the real render through the worker, waits for the
// export modal to close after the download, and returns the MP4 on disk and
// the job's id.
async function exportNow(name: string): Promise<{ mp4: string; jobId: string }> {
  const button = page.getByTestId("export-button");
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page.getByTestId("export-blocked-reason")).toHaveText("Exporting this version...");
  const worker = await runWorkerOnce(
    { R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER: "", E2E_MOCK_MASK: "" },
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  expect(worker.code, worker.output).toBe(0);
  // The export downloads by itself and the modal closes a few seconds later.
  // Until it closes it covers the page, and the ruler seeks with a raw pointer
  // click (no actionability wait), so the next capture's click would land on
  // the modal.
  await expect(page.getByTestId("export-modal")).toBeHidden({ timeout: 30_000 });
  const { data, error } = await admin
    .from("exports")
    .select("job_id, r2_key")
    .eq("reel_id", reel!.reelId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single<{ job_id: string; r2_key: string }>();
  if (error || !data) throw new Error(`export not read: ${error?.message}`);
  written.add(data.r2_key);
  const bytes = await storage.get(data.r2_key);
  if (!bytes) throw new Error(`no export at ${data.r2_key}`);
  const mp4 = join(dir, `${name}.mp4`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the spec's temp folder
  await writeFile(mp4, bytes);
  return { mp4, jobId: data.job_id };
}

// SSIM of each export frame against the preview capture at the same moment.
async function scores(
  name: string,
  mp4: string,
  previews: Capture[],
  moments = MOMENTS,
): Promise<number[]> {
  const out: number[] = [];
  for (const [index, t] of moments.entries()) {
    const { file: preview, crop } = previews[index]!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the spec's temp folder
    const { width, height } = pngSize(new Uint8Array(await readFile(preview)));
    const frame = join(dir, `${name}-export-${t}.png`);
    await extractFrame(mp4, t, width, height, frame, crop);
    out.push(await ssim(preview, frame));
    // Kept in Playwright's output (gitignored) after the temp folders go.
    await test.info().attach(`${name}-preview-${t}.png`, {
      path: preview,
      contentType: "image/png",
    });
    await test.info().attach(`${name}-export-${t}.png`, { path: frame, contentType: "image/png" });
  }
  console.log(`${name}: SSIM ${moments.map((t, i) => `${t} s ${out[i]}`).join(", ")}`);
  return out;
}

let previews: Capture[] = [];
let guardrailEditValue: Edit;

test("the export matches the live preview at every moment", async ({ baseURL }) => {
  test.setTimeout(15 * 60_000);
  guardrailEditValue = await guardrailEdit(await storedEdit(reel!.versionKey));
  const guard = await saveVersionOf(guardrailEditValue, "guardrail");

  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await openPreview(guard.id);
  previews = await capturePreview("guardrail");

  const { mp4, jobId } = await exportNow("guardrail");
  for (const score of await scores("guardrail", mp4, previews)) {
    expect(score).toBeGreaterThanOrEqual(PREVIEW_EXPORT_SSIM_BOUND);
  }

  // The render step's memory comes from sampling the whole process tree.
  const { data: step, error } = await admin
    .from("steps")
    .select("peak_rss_bytes")
    .eq("job_id", jobId)
    .eq("name", "render")
    .single<{ peak_rss_bytes: number | null }>();
  expect(error).toBeNull();
  console.log(`render peak_rss_bytes: ${step!.peak_rss_bytes}`);
  expect(step!.peak_rss_bytes).toBeGreaterThan(256 * 1024 * 1024);
});

test("text moved by 60 px falls below the bound", async () => {
  test.setTimeout(15 * 60_000);
  expect(previews).toHaveLength(MOMENTS.length);
  const probe = structuredClone(guardrailEditValue);
  const timeline = resolveTimeline(probe, await transcript());
  // The transition's own captions have no place (they show as its levels).
  const onScreen = probe.tracks.captions.filter((caption) => {
    const span = timeline.get(caption.id)!;
    return caption.position && span.start <= PROBE_MOMENT && PROBE_MOMENT < span.end;
  });
  // Each caption on screen at 1.5 s, pinned where the builder put it, then 60 px lower.
  for (const caption of onScreen) {
    const placed = await composition()
      .locator(`[id="${caption.id}"]`)
      .evaluate((el) => {
        const style = (el as HTMLElement).style;
        return { x: parseFloat(style.left), y: parseFloat(style.top) };
      });
    caption.position = { x: placed.x, y: placed.y + PROBE_SHIFT_PX, align: "left" };
  }
  // Each text level of a transition shown at 1.5 s, 60 px lower.
  let levels = 0;
  for (const transition of probe.tracks.transitions) {
    const span = timeline.get(transition.id)!;
    if (!transition.levels || PROBE_MOMENT < span.start || span.end <= PROBE_MOMENT) continue;
    for (const level of Object.values(transition.levels)) {
      level.position = { ...level.position, y: level.position.y + PROBE_SHIFT_PX };
      levels += 1;
    }
  }
  expect(onScreen.length + levels).toBeGreaterThan(0);
  const saved = await saveVersionOf(probe, "guardrail probe: the text 60 px lower");
  await openPreview(saved.id);

  const { mp4 } = await exportNow("probe");
  const probeScores = await scores("probe", mp4, previews);
  expect(Math.min(...probeScores)).toBeLessThan(PREVIEW_EXPORT_SSIM_BOUND);
});

// A VISUAL over the speaker, then one big word, behind the speaker: each a
// start over job (the scripted answer, decided from version 1) that makes the
// cut-out with the real mask tool and saves the version, then the composite in
// the live preview and in the real export are compared at the same moments.
// The visual and the word are two versions, each placed by the layout engine.
// The visual is compared at the guardrail's moments. The word's moments come
// from its own placed span (`wordMoments`), so they stay inside it wherever
// the engine puts its start and end. A ready library photo is seeded beside
// them; no version places it (the placed photo is gone).
async function startOverTo(script: string): Promise<string> {
  const { error } = await admin
    .from("jobs")
    .insert({ reel_id: reel!.reelId, owner_id: owner.id, kind: "start_over" });
  if (error) throw new Error(`start over job not queued: ${error.message}`);
  const worker = await runWorkerOnce(
    { R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_AI_SCRIPT: script, E2E_MOCK_MASK: "" },
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  expect(worker.code, worker.output).toBe(0);
  const { data } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reel!.reelId)
    .single<{ current_version_id: string }>();
  return data!.current_version_id;
}

// The moments of the big word's case, from the version's own edit: one third
// and two thirds into the word's span, and halfway from its end to the reel's
// end (the word gone in both). Never the span's end itself: the export shows
// an item up to its end frame and not on it, while the preview seeked to
// exactly the end may still show it (app_docs/export.md).
async function wordMoments(versionId: string): Promise<number[]> {
  const { data, error } = await admin
    .from("versions")
    .select("r2_key")
    .eq("id", versionId)
    .single<{ r2_key: string }>();
  if (error || !data) throw new Error(`version not read: ${error?.message}`);
  const edit = await storedEdit(data.r2_key);
  const word = (edit.tracks.behind ?? []).find((item) => item.kind === "word");
  if (!word) throw new Error("the version has no big word");
  const { start, end } = resolveTimeline(edit, await transcript()).get(word.id)!;
  const third = (end - start) / 3;
  return [start + third, start + 2 * third, (end + edit.duration) / 2].map(
    (t) => Math.round(t * 100) / 100,
  );
}

test("a visual and a big word behind the speaker match between preview and export", async () => {
  test.setTimeout(20 * 60_000);
  const dir = await mkdtemp(join(tmpdir(), "export-guardrail-behind-"));
  try {
    // The sample's colour bars, softened. As is, their one-pixel steps between
    // saturated colours cannot survive the export's 4:2:0 H.264 (a 4:2:0 round
    // trip of the preview capture scored at most 0.967306), so they would
    // measure the encoder, not preview/export parity. The fixture footage is a
    // flat colour, so the photo comes from the sample.
    const softened = join(dir, "photo.jpg");
    await softenedPhoto(SAMPLE_PHOTO, softened);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the case's temp folder
    const bytes = new Uint8Array(await readFile(softened));
    const photo: SeededPhoto = await seedReadyPhoto({
      admin,
      storage,
      ownerId: owner.id,
      prefix: CACHE_PREFIX,
      bytes,
    });
    for (const key of photo.keys) written.add(key);
    const behindId = await startOverTo(await behindVisualAnswerScript(dir));
    await openPreview(behindId);
    const behindPreviews = await capturePreview("behind");
    const { mp4 } = await exportNow("behind");
    for (const score of await scores("behind", mp4, behindPreviews)) {
      expect(score).toBeGreaterThanOrEqual(PREVIEW_EXPORT_SSIM_BOUND);
    }

    // One big word behind the speaker, a second version.
    const wordId = await startOverTo(await behindWordAnswerScript(dir, "w0001"));
    await openPreview(wordId);
    const moments = await wordMoments(wordId);
    const wordPreviews = await capturePreview("behind-word", moments);
    const { mp4: wordMp4 } = await exportNow("behind-word");
    for (const score of await scores("behind-word", wordMp4, wordPreviews, moments)) {
      expect(score).toBeGreaterThanOrEqual(PREVIEW_EXPORT_SSIM_BOUND);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    const { data: masks } = await admin
      .from("stored_files")
      .select("r2_key")
      .eq("reel_id", reel!.reelId)
      .eq("step", "cutout");
    for (const row of (masks ?? []) as { r2_key: string }[]) written.add(row.r2_key);
  }
});

// The words of the question the composition shows now: each word element at
// full opacity inside a text at full opacity, joined as the screen reads.
function questionOnScreen(): Promise<string> {
  return composition()
    .locator("body")
    .evaluate((body) =>
      [...body.ownerDocument.querySelectorAll<HTMLElement>('[id^="question-1_w"]')]
        .filter(
          (word) =>
            getComputedStyle(word).opacity === "1" &&
            getComputedStyle(word.parentElement!).opacity === "1",
        )
        .map((word) => word.textContent)
        .join(" "),
    );
}

// A QUESTION builds up word by word, each word on its own spoken moment, the
// question mark with the last one. The preview and the export are compared
// twice mid-reveal (in the two longest waits between two words, so each moment
// is well inside one state of the question) and once at its end (the whole
// question, halfway from its last word to its out-fade). Measured 2026-11-16:
// 0.995875 with one word shown (1.07 s), 0.993852 with five (1.9 s), 0.993295
// whole (2.25 s). The export's whole question against the preview with one
// word scored 0.955294, below the bound, so the comparison sees which words
// are on screen.
test("a question matches between preview and export mid-reveal and at its end", async ({
  baseURL,
}) => {
  test.setTimeout(15 * 60_000);
  const spoken = await transcript();
  const edit = await withQuestion(await storedEdit(reel!.versionKey), spoken);
  const { reveal, end } = questionOf(edit, spoken);
  expect(reveal.at(-1)!.text.endsWith("?")).toBe(true);
  const waits = reveal
    .slice(1)
    .map((word, index) => ({ from: reveal[index]!.at, to: word.at }))
    .sort((a, b) => b.to - b.from - (a.to - a.from))
    .slice(0, 2)
    .sort((a, b) => a.from - b.from);
  const fadeOut = end - ISSEBYA_PRESET.caption.outSeconds;
  const moments = [
    ...waits.map((wait) => (wait.from + wait.to) / 2),
    (reveal.at(-1)!.at + fadeOut) / 2,
  ].map((t) => Math.round(t * 100) / 100);
  const whole = reveal.map((word) => word.text).join(" ");
  const expected = moments.map((t) => questionShownAt(reveal, t));
  // Two different partial states, then the whole question with its mark.
  expect(new Set(expected).size).toBe(3);
  expect(expected[2]).toBe(whole);
  for (const partial of expected.slice(0, 2)) {
    expect(partial).not.toBe("");
    expect(partial).not.toContain("?");
  }

  const saved = await saveVersionOf(edit, "guardrail: a question");
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await openPreview(saved.id);
  // The preview shows exactly the words spoken so far at each moment.
  for (const [index, t] of moments.entries()) {
    await seekTo(t);
    expect(await questionOnScreen()).toBe(expected[index]);
  }
  const questionPreviews = await capturePreview("question", moments);
  const { mp4 } = await exportNow("question");
  for (const score of await scores("question", mp4, questionPreviews, moments)) {
    expect(score).toBeGreaterThanOrEqual(PREVIEW_EXPORT_SSIM_BOUND);
  }

  // The comparison sees the reveal: the export's whole question against the
  // preview's first partial state falls below the bound.
  const { file: partial, crop } = questionPreviews[0]!;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the spec's temp folder
  const { width, height } = pngSize(new Uint8Array(await readFile(partial)));
  const wholeFrame = join(dir, "question-export-whole.png");
  await extractFrame(mp4, moments[2]!, width, height, wholeFrame, crop);
  const mismatch = await ssim(partial, wholeFrame);
  console.log(`question: whole export against the first partial preview ${mismatch}`);
  expect(mismatch).toBeLessThan(PREVIEW_EXPORT_SSIM_BOUND);
});
