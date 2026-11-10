import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA_PRESET,
  parseEdit,
  resolveTimeline,
  transcriptSchema,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { speechTenTransitionAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { seekOnRuler } from "../test-support/ruler.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds } from "../test-support/worker.ts";
import { eventsNamed, recordEvents } from "./events.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
// The worker's Node build of the current version: the AI's unchanged version 2
// (seedProcessedReel's default script) is version 1 plus the committed hook and
// nothing else, the golden of the baseline with that hook.
const GOLDEN = new URL(
  "../../../packages/edit/src/testdata/golden/baseline-short-speech-hook.html",
  import.meta.url,
);
const TRANSCRIPT = new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url);
const SPEECH_TRANSCRIPT = new URL(
  "../../../fixtures/pipeline/speech-ten/retime/transcript.json",
  import.meta.url,
);
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

async function openReel(page: Page, baseURL: string, reelId = reel!.reelId) {
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reelId}`);
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

// A seek the way the owner makes one: a pointer down and up on the tracks
// timeline's ruler at that time.
async function setPosition(page: Page, seconds: number) {
  await seekOnRuler(page, seconds);
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

async function speechTranscript() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  return transcriptSchema.parse(JSON.parse(await readFile(SPEECH_TRANSCRIPT, "utf8")));
}

async function fixtureTranscript() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  return transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
}

test("the reel opens with the player, the first caption, one open event and the worker's build", async ({
  page,
  baseURL,
}) => {
  await routePreviewCdn(page);
  const events = await recordEvents(page);
  const cutoutRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("subject-preview.webm")) cutoutRequests.push(request.url());
  });
  await openReel(page, baseURL!);
  await expect(player(page)).toBeVisible();
  // The footage is the composition's only video: no cut-out over it.
  await expect(composition(page).locator("video")).toHaveCount(1);
  await expect(composition(page).locator("video")).toHaveAttribute(
    "src",
    /\/cache\/preview_copies\/[0-9a-f]{64}\/footage-preview\.mp4/,
  );

  await expect
    .poll(() => eventsNamed(events, "studio_preview_opened"))
    .toEqual([
      { event: "studio_preview_opened", properties: { app: "studio", reel_id: reel!.reelId } },
    ]);

  // The browser build of the current version (the AI's unchanged version 2,
  // version 1 with the hook) is the worker's Node build, byte for byte.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed golden
  const golden = await readFile(GOLDEN, "utf8");
  expect(await page.evaluate(() => window.__previewBuild)).toBe(golden);

  // The first caption is anchored on w0001 (0.038 s); captions are lower-cased.
  const transcript = await fixtureTranscript();
  const first = transcript.words.find((word) => word.id === "w0001")!;
  await setPosition(page, first.start + 0.25);
  const caption = composition(page).locator("#cw0001");
  await expect(caption).toHaveText("this");
  await expect
    .poll(() => caption.evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeGreaterThan(0.5);
  // A second look at the page sends no second open event.
  expect(eventsNamed(events, "studio_preview_opened")).toHaveLength(1);
  expect(cutoutRequests).toEqual([]);
});

test("the Zones toggle shades what TikTok and Instagram cover, and takes no clicks", async ({
  page,
  baseURL,
}) => {
  await routePreviewCdn(page);
  await openReel(page, baseURL!);
  const toggle = page.getByRole("button", { name: "Zones" });
  const layer = page.getByTestId("platform-zones");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(layer).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(layer).toBeVisible();
  // The layer fills the player's stage; each zone edge sits at the guard's
  // edge in frame pixels (1470 of 1920 down, 1045 of 1080 across), and the
  // button column's notch starts 945 across and 1164 down.
  const stage = (await layer.boundingBox())!;
  const bottom = (await layer.locator('[data-zone="bottom"]').boundingBox())!;
  const right = (await layer.locator('[data-zone="right"]').boundingBox())!;
  const buttons = (await layer.locator('[data-zone="buttons"]').boundingBox())!;
  expect(Math.abs(bottom.y - stage.y - (1470 / 1920) * stage.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(right.x - stage.x - (1045 / 1080) * stage.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(buttons.x - stage.x - (945 / 1080) * stage.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(buttons.y - stage.y - (1164 / 1920) * stage.height)).toBeLessThanOrEqual(1);

  // Play still works with the layer on.
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.locator('[data-intent="playing"]')).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator('[data-intent="paused"]')).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(layer).toHaveCount(0);
});

test("the clock waits until the footage can play, on play and after a seek", async ({
  page,
  baseURL,
}) => {
  await routePreviewCdn(page);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let releaseFootage!: () => void;
  const footageGate = new Promise<void>((resolve) => (releaseFootage = resolve));

  let footageRequests = 0;
  await page.route("**/cache/preview_copies/*/footage-preview.mp4", async (route) => {
    footageRequests += 1;
    if (footageRequests > 1) {
      await footageGate;
      await route.continue();
      return;
    }
    // Held until released: nothing of the footage can play before.
    await firstGate;
    // Then the first three quarters of the file only (about 2.0 s of the 2.69 s
    // copy): the end of the reel cannot play. Chromium's media reader waits
    // for whole 32 KiB blocks, so a smaller slice of this 44 KB fixture never
    // reaches metadata and the clock could never start.
    const headers = Object.fromEntries(
      Object.entries(route.request().headers()).filter(([name]) => name.toLowerCase() !== "range"),
    );
    const full = await route.fetch({ headers });
    const body = await full.body();
    const slice = body.subarray(0, Math.floor((body.byteLength * 3) / 4));
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes 0-${slice.byteLength - 1}/${body.byteLength}`,
      },
      body: slice,
    });
  });

  await openReel(page, baseURL!);
  await page.getByRole("button", { name: "Play" }).click();
  const held = await clockFor2s(page);
  for (const t of held) expect(Math.abs(t)).toBeLessThanOrEqual(0.001);
  await expect(page.getByRole("status").filter({ hasText: /^Loading$/ })).toBeVisible();

  releaseFirst();
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
  await routePreviewCdn(page);
  await openReel(page, baseURL!);
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  // Version 3: the current version plus two clicks on w0002 and w0005, its
  // parent the current version.
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
  const v3 = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel!.reelId,
    edit,
    changeSummary: "two clicks",
  });
  extraKeys.push(v3.key);

  await expect(page.locator(`[data-preview-version="${v3.id}"][data-preview="ready"]`)).toBeVisible(
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

// The LIST the decide step scripts on the speech clip
// (speechTenTransitionAnswerScript): one item over w0028 to w0032, its lead-in
// "they don't leave", its key phrase "to work," (from w0031) in accent text.
// A list of one item shows no number. The layer runs until w0033 starts, the
// word after the phrase. It starts after the hook (0.2 s to 3 s), so the layer
// shows.
test.describe("a LIST item on the speech clip", () => {
  let speech: ProcessedReel;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const scriptDir = await mkdtemp(join(tmpdir(), "preview-speech-"));
    try {
      speech = await seedProcessedReel({
        admin,
        storage,
        ownerId: owner.id,
        prefix: CACHE_PREFIX,
        clip: "speech-ten",
        aiScript: await speechTenTransitionAnswerScript(scriptDir),
      });
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
    extraKeys.push(...speech.keys);
  });

  test("a transition shows its lead-in and key phrase inside its layer, with no number, never the phrase's captions", async ({
    page,
    baseURL,
  }) => {
    await routePreviewCdn(page);
    await openReel(page, baseURL!, speech.reelId);

    // The version the decide step saved carries the LIST, placed by the layout engine.
    const transcript = await speechTranscript();
    const stored = await storage.get(speech.versionKey);
    const parsed = parseEdit(
      JSON.parse(new TextDecoder().decode(stored!)),
      ISSEBYA_PRESET,
      transcript,
    );
    expect(parsed.ok, parsed.ok ? "" : parsed.reasons.join("; ")).toBe(true);
    const edit = (parsed as { ok: true; edit: Edit }).edit;
    // Timing rule (specs/layout-engine.md, "Timing first"): a LIST's layer
    // comes in 0.3 s before its first word and its out-fade runs over the
    // 0.3 s after its last word, so the phrase is at full opacity while spoken.
    // The anchors are the engine's own picks for those two times (the start
    // resolves to 0.3 s before w0028, the end is w0032's end edge plus the
    // fade); the times themselves are asserted below.
    expect(edit.tracks.transitions).toEqual([
      expect.objectContaining({
        type: "numbered",
        words: ["w0028", "w0029", "w0030", "w0031", "w0032"],
        start: expect.objectContaining({ edge: "end", word: "w0026" }),
        end: { word: "w0032", edge: "end", offset: 0.3 },
        key: "w0031",
        list: 1,
      }),
    ]);
    await expect(
      page.locator(`[data-preview-version="${speech.versionId}"][data-preview="ready"]`),
    ).toBeVisible({ timeout: 30_000 });

    const frame = composition(page);
    const opacity = (selector: string) =>
      frame.locator(selector).evaluate((el) => {
        const style = getComputedStyle(el);
        return style.visibility === "hidden" || style.display === "none"
          ? 0
          : Number(style.opacity);
      });
    const resolved = resolveTimeline(edit, transcript);
    const layer = resolved.get("transition-1")!;
    const keyFirst = transcript.words.find((word) => word.id === "w0031")!;
    const keyLast = transcript.words.find((word) => word.id === "w0032")!;
    const phraseFirst = transcript.words.find((word) => word.id === "w0028")!;
    // The layer's times: in 0.3 s before the phrase's first word; the out-fade
    // runs over the 0.3 s after the last word's end, so the layer ends one
    // fade past it.
    const fade = ISSEBYA_PRESET.transitions.numbered.seconds;
    expect(layer.start).toBeCloseTo(phraseFirst.start - fade, 3);
    expect(layer.end).toBeCloseTo(keyLast.end + fade, 3);

    // While the phrase is spoken, after its key reveal (caption.inSeconds from
    // its first word) and before its last word ends, the layer and both levels
    // are at full opacity.
    const revealed = keyFirst.start + ISSEBYA_PRESET.caption.inSeconds;
    await setPosition(page, (revealed + keyLast.end) / 2);
    await expect.poll(() => opacity("#transition-1")).toBeGreaterThan(0.9);
    // A list of one item has no number level.
    await expect(frame.locator("#transition-1 #transition-1-number")).toHaveCount(0);
    // A level's lines are separated by <br />: the text nodes are the lines.
    const lines = (selector: string) =>
      frame
        .locator(selector)
        .evaluate((el) =>
          [...el.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent),
        );
    expect(await lines("#transition-1-lead")).toEqual(["they don't", "leave"]);
    expect(await lines("#transition-1-key")).toEqual(["to", "work"]);
    await expect.poll(() => opacity("#transition-1-lead")).toBeGreaterThan(0.9);
    await expect.poll(() => opacity("#transition-1-key")).toBeGreaterThan(0.9);
    const color = (selector: string) =>
      frame.locator(selector).evaluate((el) => getComputedStyle(el).color);
    // The lead-in in caption text and the key phrase in accent text: every
    // text role is white for now.
    expect(await color("#transition-1-lead")).toBe("rgb(255, 255, 255)");
    expect(await color("#transition-1-key")).toBe("rgb(255, 255, 255)");
    // The phrase's captions show nowhere else.
    for (const id of ["cw0028", "cw0029", "cw0030", "cw0031", "cw0032"]) {
      await expect(frame.locator(`#${id}`)).toHaveCount(0);
    }

    // Once its out-fade is over, the layer is gone.
    await setPosition(page, layer.end + 0.001);
    await expect.poll(() => opacity("#transition-1")).toBeLessThan(0.05);
  });
});
