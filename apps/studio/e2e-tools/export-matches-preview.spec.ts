import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { extractFrame, pngSize, ssim } from "../test-support/frames.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The guardrail: what the owner downloads is what the preview showed. The
// studio's live preview and the real exported MP4 are captured at the same
// moments and compared with ffmpeg's SSIM; a caption moved by 60 px must fall
// below the bound, so the comparison is proven sensitive. Real HyperFrames
// through the worker's `once`: the owner's Mac only, never CI.
// The bound started at 0.95 and was raised with measured evidence (never below 0.9): the guardrail
// scored 0.995673, 0.995609 and 0.997499 at 0.5, 1.5 and 2.5 s; the 60 px probe scored 0.995673,
// 0.982028 and 0.994654. 0.99 sits between the probe minimum and the guardrail minimum.
const PREVIEW_EXPORT_SSIM_BOUND = 0.99;
const MOMENTS = [0.5, 1.5, 2.5];
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

// Version 2's edit plus one accent, one dim transition crossing 1.5 s and one
// click: every kind of layer the export must match.
function guardrailEdit(base: Edit): Edit {
  const edit = structuredClone(base);
  edit.tracks.overlays.push({
    id: "accent-guard",
    start: { word: "w0005" },
    end: { word: "w0006", edge: "end" },
    kind: "accent",
    words: ["w0005"],
  });
  edit.tracks.transitions.push({
    id: "dim-guard",
    start: { time: 1.3 },
    end: { time: 1.8 },
    type: "dim",
  });
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

// Seeks the way a drag does, then waits until every video in the frame has
// finished seeking to that moment with a frame decoded, and two animation
// frames have painted.
async function seekTo(seconds: number) {
  await page.getByLabel("Position").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
  await expect
    .poll(
      () =>
        composition()
          .locator("body")
          .evaluate((body, t) => {
            const videos = [...body.ownerDocument.querySelectorAll("video")];
            return (
              videos.length > 0 &&
              videos.every(
                (video) =>
                  !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.05,
              )
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

// The player at each moment, as PNG files.
async function capturePreview(name: string): Promise<string[]> {
  const files: string[] = [];
  for (const t of MOMENTS) {
    await seekTo(t);
    const file = join(dir, `${name}-preview-${t}.png`);
    await page.locator("hyperframes-player").screenshot({ path: file });
    files.push(file);
  }
  return files;
}

// Presses Export, runs the real render through the worker, and returns the
// MP4 on disk and the job's id.
async function exportNow(name: string): Promise<{ mp4: string; jobId: string }> {
  const button = page.getByTestId("export-button");
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page.getByTestId("export-blocked-reason")).toHaveText("Exporting this version...");
  const worker = await runWorkerOnce(
    { R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER: "" },
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  expect(worker.code, worker.output).toBe(0);
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
async function scores(name: string, mp4: string, previews: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const [index, t] of MOMENTS.entries()) {
    const preview = previews[index]!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the spec's temp folder
    const { width, height } = pngSize(new Uint8Array(await readFile(preview)));
    const frame = join(dir, `${name}-export-${t}.png`);
    await extractFrame(mp4, t, width, height, frame);
    out.push(await ssim(preview, frame));
  }
  console.log(`${name}: SSIM ${MOMENTS.map((t, i) => `${t} s ${out[i]}`).join(", ")}`);
  return out;
}

let previews: string[] = [];
let guardrailEditValue: Edit;

test("the export matches the live preview at every moment", async ({ baseURL }) => {
  test.setTimeout(15 * 60_000);
  guardrailEditValue = guardrailEdit(await storedEdit(reel!.versionKey));
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

test("a caption moved by 60 px falls below the bound", async () => {
  test.setTimeout(15 * 60_000);
  expect(previews).toHaveLength(MOMENTS.length);
  const probe = structuredClone(guardrailEditValue);
  const timeline = resolveTimeline(probe, await transcript());
  const onScreen = probe.tracks.captions.filter((caption) => {
    const span = timeline.get(caption.id)!;
    return span.start <= PROBE_MOMENT && PROBE_MOMENT < span.end;
  });
  expect(onScreen.length).toBeGreaterThan(0);
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
  const saved = await saveVersionOf(probe, "guardrail probe: a caption 60 px lower");
  await openPreview(saved.id);

  const { mp4 } = await exportNow("probe");
  const probeScores = await scores("probe", mp4, previews);
  expect(Math.min(...probeScores)).toBeLessThan(PREVIEW_EXPORT_SSIM_BOUND);
});
