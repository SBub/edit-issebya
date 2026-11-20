import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA_PRESET,
  hookReveal,
  parseEdit,
  revealShownAt,
  resolveTimeline,
  soundCues,
  transcriptSchema,
  typedCount,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { speechTenTransitionAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { seekOnRuler } from "../test-support/ruler.ts";
import { questionOf, revealOf, withAccent, withQuestion } from "../test-support/transitions.ts";
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

// The hook of the seeded version ("A short test for the real studio", from
// 0.2 s to the reel's end): the preview types it letter by letter, a steady
// caret after the last typed letter, every letter in its final place from the
// start, the whole line on screen (and the caret gone) from 60% of its time,
// and a key sound scheduled on the letters at the gain set against the voice.
test("the hook is typed letter by letter, whole at 60% of its time, with a key sound in step", async ({
  page,
  baseURL,
}) => {
  await routePreviewCdn(page);
  await openReel(page, baseURL!);
  const transcript = await fixtureTranscript();
  const stored = await storage.get(reel!.versionKey);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    transcript,
  );
  expect(parsed.ok, parsed.ok ? "" : parsed.reasons.join("; ")).toBe(true);
  const edit = (parsed as { ok: true; edit: Edit }).edit;
  const item = edit.tracks.overlays.find((overlay) => overlay.kind === "hook")!;
  expect(item.text).toBe("A short test for the real studio");
  const resolved = resolveTimeline(edit, transcript);
  const span = resolved.get(item.id)!;
  const reveal = hookReveal(item.text!, span);
  const letters = reveal.map((letter) => letter.text).join("");
  expect(letters).toBe("Ashorttestfortherealstudio");
  // Fully typed at 60% of its shown span, then held.
  const typedAt = reveal.at(-1)!.at;
  expect(reveal[0]!.at).toBe(span.start);
  expect(typedAt).toBeCloseTo(span.start + (span.end - span.start) * 0.6, 3);

  const hook = composition(page).locator('[id="hook"]');
  // Every letter is its own element, and every one but the last holds its
  // caret; nothing else is in the line.
  await expect(hook.locator(".ch")).toHaveCount(reveal.length);
  await expect(hook.locator(".ch > .cr")).toHaveCount(reveal.length - 1);
  await expect(hook.locator(".cr")).toHaveCount(reveal.length - 1);
  expect(await hook.evaluate((el) => el.textContent)).toBe("A short test forthe real studio");
  expect(await hook.evaluate((el) => el.querySelectorAll("br").length)).toBe(1);
  // The hook's own look is unchanged: the accent's face, white, centred lines.
  expect(await hook.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
    "Playfair Display",
  );
  await expect(hook).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(hook).toHaveCSS("text-align", "center");

  // The letters on screen: at full opacity inside a line at full opacity.
  const onScreen = () =>
    hook.evaluate((el) =>
      getComputedStyle(el).opacity === "1"
        ? [...el.querySelectorAll<HTMLElement>(".ch")]
            .filter((letter) => getComputedStyle(letter).opacity === "1")
            .map((letter) => letter.textContent)
            .join("")
        : "",
    );
  const places = () =>
    hook.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>(".ch")].map((letter) => {
        const box = letter.getBoundingClientRect();
        return [Math.round(box.left), Math.round(box.top)];
      }),
    );

  // A seek rests on a frame of the reel, so the letters on screen are read
  // together with the page's own time (its timeline's), which must be clear
  // of any letter's moment.
  const typedNear = async (target: number) => {
    await setPosition(page, target);
    const read = () =>
      hook.evaluate((el) => {
        const timelines = (
          el.ownerDocument.defaultView as unknown as {
            __timelines: Record<string, { time(): number }>;
          }
        ).__timelines;
        return {
          time: timelines.main!.time(),
          shown:
            getComputedStyle(el).opacity === "1"
              ? [...el.querySelectorAll<HTMLElement>(".ch")]
                  .filter((letter) => getComputedStyle(letter).opacity === "1")
                  .map((letter) => letter.textContent)
                  .join("")
              : "",
        };
      });
    await expect.poll(async () => Math.abs((await read()).time - target)).toBeLessThan(0.05);
    const { time, shown } = await read();
    expect(reveal.every((letter) => Math.abs(letter.at - time) > 0.002)).toBe(true);
    // Exactly the letters whose moment has come, in order, and none after.
    const count = typedCount(reveal, time);
    expect(shown).toBe(letters.slice(0, count));
    return count;
  };

  // The carets on screen: the bar of each caret at full opacity inside a
  // letter and a line at full opacity, with the letter it stands after.
  const carets = () =>
    hook.evaluate((el) => {
      const root = el.ownerDocument.documentElement.getBoundingClientRect();
      const view = el.ownerDocument.defaultView!;
      if (view.getComputedStyle(el).opacity !== "1") return [];
      return [...el.querySelectorAll<HTMLElement>(".cr")]
        .filter(
          (caret) =>
            view.getComputedStyle(caret).opacity === "1" &&
            view.getComputedStyle(caret.parentElement!).opacity === "1",
        )
        .map((caret) => {
          const letter = caret.parentElement!;
          const bar = view.getComputedStyle(caret, "::before");
          const box = caret.getBoundingClientRect();
          const of = letter.getBoundingClientRect();
          const size = parseFloat(view.getComputedStyle(el).fontSize);
          const scale = of.height / letter.offsetHeight || 1;
          return {
            after: [...el.querySelectorAll(".ch")].indexOf(letter) + 1,
            left: box.left - root.left,
            letterRight: of.right - root.left,
            top: box.top - root.top,
            letterTop: of.top - root.top,
            letterBottom: of.bottom - root.top,
            // In the page's own pixels, against the text's size.
            width: parseFloat(bar.width) / size,
            height: parseFloat(bar.height) / size,
            color: bar.backgroundColor,
            animation: bar.animationName,
            scale,
          };
        });
    });
  // One steady bar right after the last typed letter: thin, about a capital's
  // height, in the hook's colour, starting where the letter ends.
  const caretAfter = async (count: number) => {
    const shown = await carets();
    expect(shown).toHaveLength(1);
    const [caret] = shown;
    expect(caret!.after).toBe(count);
    expect(caret!.color).toBe("rgb(255, 255, 255)");
    expect(caret!.animation).toBe("none");
    expect(caret!.width).toBeCloseTo(0.05, 2);
    expect(caret!.height).toBeCloseTo(0.7, 2);
    expect(caret!.left).toBeGreaterThanOrEqual(caret!.letterRight - 1);
    expect(caret!.left - caret!.letterRight).toBeLessThanOrEqual(0.1 * 110 * caret!.scale);
    // On the letter's own line.
    expect(caret!.top).toBeGreaterThanOrEqual(caret!.letterTop - 1);
    expect(caret!.top).toBeLessThan(caret!.letterBottom);
    return caret!;
  };

  // Before it starts: nothing of it.
  await setPosition(page, span.start - 0.1);
  await expect.poll(onScreen).toBe("");
  expect(await carets()).toEqual([]);
  // In the middle of the typing: the first part of the text and nothing
  // after it.
  const shown = await typedNear((span.start + typedAt) / 2);
  expect(shown).toBeGreaterThan(reveal.length / 4);
  expect(shown).toBeLessThan((reveal.length * 3) / 4);
  const placesDuring = await places();
  const caretDuring = await caretAfter(shown);
  // A moment later: more of it, still not all, and the caret has moved on
  // with the letters (here onto the second line).
  const later = await typedNear(typedAt - 0.15);
  expect(later).toBeGreaterThan(shown);
  expect(later).toBeLessThan(reveal.length);
  const caretLater = await caretAfter(later);
  expect(caretLater.top).toBeGreaterThan(caretDuring.top);
  // From 60% of its time on: the whole line, and it holds, with no caret.
  await setPosition(page, typedAt + 0.1);
  await expect.poll(onScreen).toBe(letters);
  expect(await carets()).toEqual([]);
  await setPosition(page, span.end - ISSEBYA_PRESET.caption.outSeconds - 0.1);
  await expect.poll(onScreen).toBe(letters);
  expect(await carets()).toEqual([]);
  // No letter moved while the line was typed: the lines never reflow.
  expect(await places()).toEqual(placesDuring);
  // The line is as wide as the same text written in one piece: a letter of
  // its own is set exactly where the plain text has it.
  const widths = await hook.evaluate((el) => {
    const plain = el.cloneNode(false) as HTMLElement;
    plain.removeAttribute("id");
    plain.style.visibility = "hidden";
    plain.innerHTML = [...el.childNodes]
      .map((node) => (node.nodeName === "BR" ? "<br />" : (node.textContent ?? "")))
      .join("");
    el.parentElement!.append(plain);
    const out = [el.getBoundingClientRect().width, plain.getBoundingClientRect().width];
    plain.remove();
    return out;
  });
  expect(widths[0]).toBeGreaterThan(0);
  expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(0.5);

  // The key sounds play through Web Audio only, never through the page's
  // <audio>, each scheduled on the moment its letter appears.
  await expect(composition(page).locator("audio")).toHaveCount(0);
  // Their gain is set against the voice the seeded transcript measured, the
  // number the export's clips carry.
  expect(transcript.voice).toBeDefined();
  const cues = soundCues(edit, resolved, ISSEBYA_PRESET, transcript.voice);
  expect(cues.length).toBeGreaterThan(5);
  expect(cues.every((cue) => cue.volume > 0.2)).toBe(true);
  expect(cues.every((cue) => cue.id.startsWith("hook_k"))).toBe(true);
  const moments = new Set(reveal.map((letter) => letter.at));
  expect(cues.every((cue) => moments.has(cue.at) && cue.at <= typedAt)).toBe(true);
  await setPosition(page, 0);
  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__previewSounds?.starts.length ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(cues.length);
  const sounds = (await page.evaluate(() => window.__previewSounds))!;
  const { ctxTime, playhead } = sounds.playbacks[0]!;
  expect(playhead).toBeLessThan(span.start);
  const starts = sounds.starts.slice(0, cues.length);
  expect(starts.map((start) => start.id)).toEqual(cues.map((cue) => cue.id));
  for (const [index, start] of starts.entries()) {
    expect(start.offset).toBe(0);
    expect(Math.abs(start.when - (ctxTime - playhead) - cues[index]!.at)).toBeLessThanOrEqual(0.01);
    // Played at the very gain the export's clip is mixed at.
    expect(start.gain).toBe(cues[index]!.volume);
  }
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
  // edge in frame pixels (1470 of 1920 down, 1010 of 1080 across), and the
  // button column's notch starts 880 across and 833 down.
  const stage = (await layer.boundingBox())!;
  const bottom = (await layer.locator('[data-zone="bottom"]').boundingBox())!;
  const right = (await layer.locator('[data-zone="right"]').boundingBox())!;
  const buttons = (await layer.locator('[data-zone="buttons"]').boundingBox())!;
  expect(Math.abs(bottom.y - stage.y - (1470 / 1920) * stage.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(right.x - stage.x - (1010 / 1080) * stage.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(buttons.x - stage.x - (880 / 1080) * stage.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(buttons.y - stage.y - (833 / 1920) * stage.height)).toBeLessThanOrEqual(1);

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
    // Then the first three quarters of the file only, and never less than one
    // whole 32 KiB block (about 2.0 s of the 2.7 s copy): the end of the reel
    // cannot play. Chromium's media reader waits for whole 32 KiB blocks, so a
    // smaller slice never reaches metadata and the clock could never start
    // (three quarters of the 44 KB fixture is 33 KB, just over one block).
    const headers = Object.fromEntries(
      Object.entries(route.request().headers()).filter(([name]) => name.toLowerCase() !== "range"),
    );
    const full = await route.fetch({ headers });
    const body = await full.body();
    const slice = body.subarray(0, Math.max(Math.floor((body.byteLength * 3) / 4), 32 * 1024));
    expect(slice.byteLength).toBeLessThan(body.byteLength);
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
  // Every sound file the preview asks the edit-assets route for.
  const soundFiles: string[] = [];
  page.on("request", (request) => {
    const file = /\/edit-assets\/assets\/sounds\/([^/?]+)/.exec(request.url())?.[1];
    if (file) soundFiles.push(file);
  });
  await openReel(page, baseURL!);
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  // Version 3: the current version plus a click on w0002 and, on w0005, a
  // VISUAL card with its cue (`click-visual-1`, stored as a click like every
  // cue), its parent the current version.
  const transcript = await fixtureTranscript();
  const stored = await storage.get(reel!.versionKey);
  const json = JSON.parse(new TextDecoder().decode(stored!)) as {
    tracks: { sounds: unknown[]; behind?: unknown[] };
  };
  json.tracks.behind = [
    {
      id: "visual-1",
      kind: "visual",
      box: { x: 90, y: 300, width: 360, height: 460 },
      start: { word: "w0005" },
      end: { word: "w0008", edge: "end" },
    },
  ];
  json.tracks.sounds = [
    {
      id: "click-a",
      sound: "click",
      start: { word: "w0002" },
      end: { word: "w0002", offset: 0.2 },
    },
    {
      id: "click-visual-1",
      sound: "click",
      start: { word: "w0005" },
      end: { word: "w0008", edge: "end" },
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
    changeSummary: "a click and a card",
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
  // The card comes in with the pop, the other sound stays the click
  // (app_docs/edit-model.md, "Preset values"), and the version's typed hook
  // plays its four key sounds ("The typed hook").
  await expect
    .poll(() => [...new Set(soundFiles)].sort())
    .toEqual([
      "mouse-click-trimmed.wav",
      "pop.wav",
      "typing-key-1.wav",
      "typing-key-2.wav",
      "typing-key-3.wav",
      "typing-key-4.wav",
    ]);

  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__previewSounds?.starts.length ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(2);
  const sounds = (await page.evaluate(() => window.__previewSounds))!;
  // The first playback, from 0, scheduled both sounds, the pop as its card
  // comes in.
  const { ctxTime, playhead } = sounds.playbacks[0]!;
  const resolved = resolveTimeline(edit, transcript);
  const starts = sounds.starts.slice(0, 2);
  expect(starts.map((start) => start.id)).toEqual(["click-a", "click-visual-1"]);
  expect(resolved.get("click-visual-1")!.start).toBe(resolved.get("visual-1")!.start);
  for (const start of starts) {
    const at = resolved.get(start.id)!.start;
    expect(Math.abs(start.when - (ctxTime - playhead) - at)).toBeLessThanOrEqual(0.01);
  }
});

// A QUESTION on the fixture clip ("test clip for the real studio?", w0005 to
// w0010): the preview builds it up word by word as the words are spoken, shows
// the question mark with the last word, keeps the whole question until it
// leaves, and never shows its words as captions meanwhile.
test("a question builds up word by word as it is spoken, with a question mark at its end", async ({
  page,
  baseURL,
}) => {
  await routePreviewCdn(page);
  await openReel(page, baseURL!);
  const transcript = await fixtureTranscript();
  const stored = await storage.get(reel!.versionKey);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    transcript,
  );
  expect(parsed.ok, parsed.ok ? "" : parsed.reasons.join("; ")).toBe(true);
  const edit = await withQuestion((parsed as { ok: true; edit: Edit }).edit, transcript);
  const saved = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel!.reelId,
    edit,
    changeSummary: "a question",
  });
  extraKeys.push(saved.key);
  await expect(
    page.locator(`[data-preview-version="${saved.id}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });

  const { reveal, start, end } = questionOf(edit, transcript);
  const whole = "test clip for the real studio?";
  expect(reveal.map((word) => word.text).join(" ")).toBe(whole);
  const question = composition(page).locator('[id="question-1"]');
  // Every word is its own element in its final place: the lines never reflow.
  await expect(question.locator(".q")).toHaveText(whole.split(" "));
  await expect(question).not.toHaveCSS("text-align", "center");
  // The accent's own face and colour.
  const accentFamily = await question.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(accentFamily).toContain("Playfair Display");
  await expect(question).toHaveCSS("color", "rgb(255, 255, 255)");

  // The words on screen: at full opacity inside a text at full opacity.
  const onScreen = () =>
    question.evaluate((el) =>
      getComputedStyle(el).opacity === "1"
        ? [...el.querySelectorAll<HTMLElement>(".q")]
            .filter((word) => getComputedStyle(word).opacity === "1")
            .map((word) => word.textContent)
            .join(" ")
        : "",
    );
  const places = () =>
    question.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>(".q")].map((word) => {
        const box = word.getBoundingClientRect();
        return [Math.round(box.left), Math.round(box.top)];
      }),
    );
  // Before it starts: nothing of it.
  await setPosition(page, start - 0.2);
  await expect.poll(onScreen).toBe("");
  // Halfway through each word: the question as far as it has been spoken.
  const firstPlaces = await places();
  for (const [index, word] of reveal.entries()) {
    const next = reveal[index + 1]?.at ?? end - ISSEBYA_PRESET.caption.outSeconds;
    const t = (word.at + next) / 2;
    await setPosition(page, t);
    const shown = revealShownAt(reveal, t);
    expect(shown.split(" ")).toHaveLength(index + 1);
    await expect.poll(onScreen).toBe(shown);
    expect(shown.includes("?")).toBe(index === reveal.length - 1);
    expect(await places()).toEqual(firstPlaces);
  }
  // Its words are not captions while it shows.
  const captions = await composition(page)
    .locator("#text > .text:not(#question-1):not(.hook)")
    .evaluateAll((els) =>
      els
        .filter((el) => Number(getComputedStyle(el).opacity) > 0)
        .map((el) => el.textContent ?? ""),
    );
  for (const word of ["clip", "real", "studio"]) {
    expect(captions.join(" ")).not.toContain(word);
  }
});

// The word-by-word entrance (app_docs/edit-model.md, "The word-by-word
// entrance"): an ACCENT on the fixture clip ("test clip for the real studio",
// w0005 to w0010) and its captions build up word by word, each word cutting in
// as it is spoken, in its final place from the start; the captions under the
// accent stay off the page.
test("an accent and a caption build up word by word as they are spoken", async ({
  page,
  baseURL,
}) => {
  await routePreviewCdn(page);
  await openReel(page, baseURL!);
  const transcript = await fixtureTranscript();
  const stored = await storage.get(reel!.versionKey);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    transcript,
  );
  expect(parsed.ok, parsed.ok ? "" : parsed.reasons.join("; ")).toBe(true);
  const edit = await withAccent((parsed as { ok: true; edit: Edit }).edit, transcript);
  const saved = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel!.reelId,
    edit,
    changeSummary: "an accent",
  });
  extraKeys.push(saved.key);
  await expect(
    page.locator(`[data-preview-version="${saved.id}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });

  const frame = composition(page);
  // The words of a text on screen: at full opacity inside a text at full
  // opacity. A word that was still fading or rising in would not count.
  const onScreen = (id: string) =>
    frame.locator(`[id="${id}"]`).evaluate((el) =>
      getComputedStyle(el).opacity === "1"
        ? [...el.querySelectorAll<HTMLElement>(".q")]
            .filter((word) => getComputedStyle(word).opacity === "1")
            .map((word) => word.textContent)
            .join(" ")
        : "",
    );
  const places = (id: string) =>
    frame.locator(`[id="${id}"]`).evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>(".q")].map((word) => {
        const box = word.getBoundingClientRect();
        return [Math.round(box.left), Math.round(box.top)];
      }),
    );
  // No rise: the text never moves.
  const moved = (id: string) =>
    frame.locator(`[id="${id}"]`).evaluate((el) => {
      const { transform } = getComputedStyle(el);
      return transform !== "none" && transform !== "matrix(1, 0, 0, 1, 0, 0)";
    });

  // The accent: every word its own element, no mark added.
  const accent = revealOf(edit, transcript, "accent-1");
  const whole = "test clip for the real studio";
  expect(accent.reveal.map((word) => word.text).join(" ")).toBe(whole);
  await expect(frame.locator('[id="accent-1"] .q')).toHaveText(whole.split(" "));
  await setPosition(page, accent.start - 0.05);
  await expect.poll(() => onScreen("accent-1")).toBe("");
  const accentPlaces = await places("accent-1");
  for (const [index, word] of accent.reveal.entries()) {
    const next = accent.reveal[index + 1]?.at ?? accent.end - ISSEBYA_PRESET.caption.outSeconds;
    const t = (word.at + next) / 2;
    await setPosition(page, t);
    const shown = revealShownAt(accent.reveal, t);
    expect(shown.split(" ")).toHaveLength(index + 1);
    await expect.poll(() => onScreen("accent-1")).toBe(shown);
    expect(await places("accent-1")).toEqual(accentPlaces);
    expect(await moved("accent-1")).toBe(false);
  }
  // The captions of the accent's words stay hidden: they are not on the page.
  for (const id of ["cw0005", "cw0006", "cw0007", "cw0008", "cw0009", "cw0010"]) {
    await expect(frame.locator(`[id="${id}"]`)).toHaveCount(0);
  }

  // The captions: "this" on its word, then "is so" (one spoken word written as
  // two, so both words cut in together), each whole a moment after its word
  // starts, with no fade in and no rise.
  const first = revealOf(edit, transcript, "cw0001");
  const fixed = revealOf(edit, transcript, "cw0002");
  expect(first.reveal.map((word) => word.text)).toEqual(["this"]);
  expect(fixed.reveal).toEqual([
    { text: "is", at: fixed.start },
    { text: "so", at: fixed.start },
  ]);
  await expect(frame.locator('[id="cw0002"] .q')).toHaveText(["is", "so"]);
  const fixedPlaces = await places("cw0002");
  // Between the two words: the first caption is on, the second not yet.
  await setPosition(page, (first.start + fixed.start) / 2);
  await expect.poll(() => onScreen("cw0001")).toBe("this");
  await expect.poll(() => onScreen("cw0002")).toBe("");
  // 0.03 s after its word starts the second caption is whole: the old 0.18 s
  // rise would still be fading in.
  await setPosition(page, fixed.start + 0.03);
  await expect.poll(() => onScreen("cw0002")).toBe("is so");
  expect(await moved("cw0002")).toBe(false);
  expect(await places("cw0002")).toEqual(fixedPlaces);
  await expect.poll(() => onScreen("cw0001")).toBe("this");
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
    // Timing rule (specs/layout-engine.md, decision 25): a LIST's layer comes
    // in 0.3 s before its first word and its out-fade runs over the 0.3 s after
    // its last word, unless the next text starts first, so the phrase is at full
    // opacity while spoken. The start anchor is the engine's own pick for 0.3 s
    // before w0028 (the word it anchors to follows the fixture's word times);
    // both its times are checked below from the resolved spans, not from the
    // anchors.
    expect(edit.tracks.transitions).toEqual([
      expect.objectContaining({
        type: "numbered",
        words: ["w0028", "w0029", "w0030", "w0031", "w0032"],
        start: expect.objectContaining({ edge: "end" }),
        end: expect.objectContaining({ edge: "end" }),
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
    // The layer's times: in 0.3 s before the phrase's first word; it ends one
    // fade past the last word, or at the next text's start when that comes
    // first. Caption cw0033 ("they", w0033) starts before the fade would end,
    // so the layer ends as it starts.
    const fade = ISSEBYA_PRESET.transitions.numbered.seconds;
    const next = resolved.get("cw0033")!;
    expect(next.start).toBeLessThan(keyLast.end + fade);
    expect(layer.start).toBeCloseTo(phraseFirst.start - fade, 3);
    expect(layer.end).toBeCloseTo(Math.min(keyLast.end + fade, next.start), 3);

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
    expect(await lines("#transition-1-lead")).toEqual(["they don't leave"]);
    expect(await lines("#transition-1-key")).toEqual(["to work"]);
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

    // Once the layer has left, the next caption shows as usual: cw0033 cuts in
    // at its start (checked from caption.inSeconds on, the length of the rise it
    // had before) and fades out over caption.outSeconds at its end. The layer and the caption never share a moment (the layer ends
    // where the caption starts), so the caption is checked at full opacity
    // between the two fades.
    expect(layer.end).toBeLessThanOrEqual(next.start + 1e-6);
    await setPosition(page, layer.end + 0.001);
    await expect.poll(() => opacity("#transition-1")).toBeLessThan(0.05);
    const nextShown = frame.locator("#cw0033");
    await expect(nextShown).toHaveText("they");
    const shownFrom = next.start + ISSEBYA_PRESET.caption.inSeconds;
    const shownTo = next.end - ISSEBYA_PRESET.caption.outSeconds;
    expect(shownFrom).toBeLessThan(shownTo);
    await setPosition(page, (shownFrom + shownTo) / 2);
    await expect.poll(() => opacity("#cw0033")).toBeGreaterThan(0.9);
  });
});
