import { readFile } from "node:fs/promises";
import {
  type Edit,
  ISSEBYA_PRESET,
  parseEdit,
  resolveTimeline,
  transcriptSchema,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { formatClock } from "../src/lib/tracks-timeline.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { ruler, rulerPoint } from "../test-support/ruler.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const TRANSCRIPT = new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const EXTRA_VERSIONS = 12;
const LONG_TITLE =
  "Transitions made much longer and softer everywhere in the reel, with a photo behind you";
const LONG_REQUEST =
  "please make every transition slower and softer, put the kitchen photo behind me while I talk about cooking, and make the captions a little bigger";
const EXTRA_STEPS = 40;
const EXTRA_JOBS = 8;
const FOCUSABLE =
  "a, button, input, select, textarea, [tabindex], [contenteditable], [draggable=true]";

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
const extraKeys: string[] = [];

test.describe.configure({ mode: "serial" });

async function fixtureTranscript() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  return transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
}

// The current version's edit, as the storage double holds it.
async function currentEdit(): Promise<Edit> {
  const { data, error } = await admin
    .from("reels")
    .select("current_version:versions!reels_current_version_fkey(r2_key)")
    .eq("id", reel!.reelId)
    .single<{ current_version: { r2_key: string } }>();
  if (error || !data) throw new Error(`current version not read: ${error?.message}`);
  const stored = await storage.get(data.current_version.r2_key);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    await fixtureTranscript(),
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  return parsed.edit;
}

async function versionRows(): Promise<{ id: string; number: number }[]> {
  const { data, error } = await admin
    .from("versions")
    .select("id, number")
    .eq("reel_id", reel!.reelId)
    .order("number");
  if (error) throw new Error(`versions not read: ${error.message}`);
  return data as { id: string; number: number }[];
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "reel-layout");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });

  // 14 versions in all: long enough that the list must scroll in its area.
  // Their texts differ in length (a long title, no title with a long request,
  // a short title), so the rows' one fixed height (two title lines) is tested.
  const edit = await currentEdit();
  for (let n = 0; n < EXTRA_VERSIONS; n += 1) {
    const saved = await saveTestVersion({
      admin,
      storage,
      prefix: CACHE_PREFIX,
      reelId: reel.reelId,
      edit,
      request: n % 3 === 1 ? LONG_REQUEST : `layout change ${n + 3}`,
      changeTitle: [LONG_TITLE, null, "Photo added"][n % 3]!,
      changeSummary: `layout version ${n + 3}`,
    });
    extraKeys.push(saved.key);
  }

  // Finished jobs (never claimable) and a long step log.
  const jobs = await admin
    .from("jobs")
    .insert(
      Array.from({ length: EXTRA_JOBS }, () => ({
        reel_id: reel!.reelId,
        owner_id: owner.id,
        status: "done",
      })),
    )
    .select("id");
  if (jobs.error || !jobs.data) throw new Error(`jobs not inserted: ${jobs.error?.message}`);
  const jobId = (jobs.data[0] as { id: string }).id;
  const steps = await admin.from("steps").insert(
    Array.from({ length: EXTRA_STEPS }, (_, n) => ({
      job_id: jobId,
      reel_id: reel!.reelId,
      owner_id: owner.id,
      name: `layout_step_${n}`,
      status: "done",
      summary: `layout step ${n} done, 1 second`,
    })),
  );
  if (steps.error) throw new Error(`steps not inserted: ${steps.error.message}`);
});

test.afterAll(async () => {
  for (const key of [...(reel?.keys ?? []), ...extraKeys]) await storage.delete(key);
  // The cascade removes the reel, its jobs, steps, versions and stored files.
  if (owner) await deleteTestUser(admin, owner.id);
});

async function openReel(page: Page, baseURL: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await routePreviewCdn(page);
  await page.goto(await signInLink(admin, owner.email, baseURL));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(page.locator('[data-realtime="ready"]')).toBeVisible({ timeout: 30_000 });
  // The first open compiles the page, the builder and harfbuzzjs under `next dev`.
  await expect(page.locator('[data-preview="ready"]')).toBeVisible({ timeout: 30_000 });
}

// The document never scrolls: measured from the root box, never the window.
async function expectNoPageScroll(page: Page) {
  const sizes = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    bodyScrollHeight: document.body.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(sizes.scrollHeight).toBe(sizes.clientHeight);
  expect(sizes.bodyScrollHeight).toBeLessThanOrEqual(sizes.clientHeight);
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
}

// Inside the root box, so clipping cannot fake a pass.
async function expectInsideRoot(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  const root = await page.evaluate(() => {
    const rect = document.documentElement.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: Math.min(rect.bottom, document.documentElement.clientHeight),
    };
  });
  expect(box.x).toBeGreaterThanOrEqual(root.left);
  expect(box.y).toBeGreaterThanOrEqual(root.top);
  expect(box.x + box.width).toBeLessThanOrEqual(root.right + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(root.bottom + 0.5);
}

// The area scrolls inside its own box, and scrolling it moves no page.
async function expectOwnScroll(page: Page, area: Locator) {
  const own = await area.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(own.scrollHeight).toBeGreaterThan(own.clientHeight);
  expect(own.overflowY).toBe("auto");
  await area.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
}

// The reel page has no ready-notification control: no button, toggle or
// blocked note.
async function expectNoNotifyControl(page: Page) {
  await expect(page.getByRole("button", { name: /notif/i })).toHaveCount(0);
  await expect(page.getByText(/notif/i)).toHaveCount(0);
  await expect(page.locator('[data-testid^="notify"]')).toHaveCount(0);
}

// Send sits inside the field's box, like a chat composer: a small square
// icon button in its bottom right corner, no text, and the text never runs
// under it (the textarea's right padding is at least the button's width).
async function expectSendAtBottomRight(page: Page) {
  const box = (await page.getByTestId("change-field").boundingBox())!;
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toHaveText("");
  await expect(sendButton).toHaveAttribute("title", "Send");
  const send = (await sendButton.boundingBox())!;
  expect(send.x).toBeGreaterThanOrEqual(box.x);
  expect(send.y).toBeGreaterThanOrEqual(box.y);
  const right = box.x + box.width - (send.x + send.width);
  const bottom = box.y + box.height - (send.y + send.height);
  for (const gap of [right, bottom]) {
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(16);
  }
  expect(Math.abs(send.width - send.height)).toBeLessThanOrEqual(1);
  expect(send.width).toBeLessThanOrEqual(48);
  const paddingRight = await page
    .getByLabel("Ask for a change")
    .evaluate((element) => parseFloat(getComputedStyle(element).paddingRight));
  expect(paddingRight).toBeGreaterThanOrEqual(send.width + right);
}

// The desktop split, measured from the root box (never the window): the edit
// area over the full height under the header; on its right Versions and the
// library side by side, each the top 68%; the correction field the bottom
// 32%, across both, with a tall field and Send in its bottom right corner.
async function expectDesktopSplit(page: Page) {
  const column = await page.evaluate(() => {
    const header = document.querySelector("header")!.getBoundingClientRect();
    const root = document.documentElement.getBoundingClientRect();
    return {
      top: header.bottom,
      bottom: Math.min(root.bottom, document.documentElement.clientHeight),
    };
  });
  const full = column.bottom - column.top;
  const edit = (await page.getByTestId("edit-area").boundingBox())!;
  const versions = (await page.getByTestId("versions-area").boundingBox())!;
  const library = (await page.getByTestId("library-area").boundingBox())!;
  const change = (await page.getByTestId("change-area").boundingBox())!;

  expect(Math.abs(edit.y - column.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(edit.height - full)).toBeLessThanOrEqual(1);

  for (const box of [versions, library]) {
    expect(Math.abs(box.y - column.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - full * 0.68)).toBeLessThanOrEqual(1);
  }
  expect(versions.x).toBeGreaterThanOrEqual(edit.x + edit.width - 0.5);
  expect(Math.abs(library.x - (versions.x + versions.width))).toBeLessThanOrEqual(1);

  expect(Math.abs(change.y - (versions.y + versions.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(change.y + change.height - column.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(change.x - versions.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(change.width - (versions.width + library.width))).toBeLessThanOrEqual(1);

  // The field grows into the space; its box holds Send at the bottom right.
  const field = (await page.getByLabel("Ask for a change").boundingBox())!;
  expect(field.height).toBeGreaterThanOrEqual(change.height / 2);
  const box = (await page.getByTestId("change-field").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(change.x - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(change.y + change.height + 0.5);
  await expectSendAtBottomRight(page);

  // The DOM (and so the tab order) follows the reading order: edit,
  // Versions, library, then the correction field.
  const order = await page.evaluate(() =>
    ["edit-area", "versions-area", "library-area", "change-area"].map((id) =>
      Array.from(document.querySelectorAll("[data-testid]")).indexOf(
        document.querySelector(`[data-testid="${id}"]`)!,
      ),
    ),
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);
}

test("one screen at 1440x900: preview, timeline, change box and the side panel at once", async ({
  page,
  baseURL,
}) => {
  await openReel(page, baseURL!, DESKTOP);
  await expect(page.getByTestId("version-item")).toHaveCount(2 + EXTRA_VERSIONS);
  // The seeded steps exist, but the page shows no Status area and no step log.
  await expect(page.getByTestId("status-area")).toHaveCount(0);
  await expect(page.getByTestId("step-line")).toHaveCount(0);

  await expectNoPageScroll(page);
  await expectInsideRoot(page, page.getByRole("button", { name: "Send" }));
  await expectInsideRoot(page, page.getByTestId("export-button"));
  await expectInsideRoot(page, page.getByTestId("tracks"));
  await expectNoNotifyControl(page);
  await expect(page.locator("hyperframes-player")).toBeVisible();
  await expect(page.getByTestId("version-item").first()).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Reel" })).toBeHidden();
  // The photo library is a third column, beside the side panel.
  await expect(page.getByTestId("library-area")).toBeVisible();
  await expectInsideRoot(page, page.getByRole("button", { name: "Upload a photo" }));

  await expectDesktopSplit(page);
  await expectOwnScroll(page, page.getByTestId("versions-area"));
  await expectNoPageScroll(page);

  // Pitch black theme: the page and the edit area are black; only the
  // navigation, the tracks timeline and the change field are lifted.
  const background = (locator: Locator) =>
    locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await background(page.locator("body"))).toBe("rgb(0, 0, 0)");
  expect(await background(page.getByTestId("edit-area"))).toBe("rgb(0, 0, 0)");
  for (const lifted of [
    page.locator("header"),
    page.getByTestId("tracks"),
    page.getByTestId("change-field"),
  ]) {
    const colour = await background(lifted);
    expect(colour).not.toBe("rgb(0, 0, 0)");
    expect(colour).not.toBe("rgba(0, 0, 0, 0)");
  }
});

// Every version is one line at one height whatever its text; the arrow opens
// its details in place.
for (const [size, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", PHONE],
] as const) {
  test(`the versions list: one line per version, details behind the arrow at ${size}`, async ({
    page,
    baseURL,
  }) => {
    await openReel(page, baseURL!, viewport);
    if (viewport === PHONE) {
      await page
        .getByRole("tablist", { name: "Reel" })
        .getByRole("tab", { name: "Versions" })
        .click();
    }
    const items = page.getByTestId("version-item");
    await expect(items).toHaveCount(2 + EXTRA_VERSIONS);
    const heights = async () =>
      items.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    const collapsed = await heights();
    for (const height of collapsed) expect(Math.abs(height - collapsed[0]!)).toBeLessThanOrEqual(1);

    const item = (number: number) =>
      page.locator(`[data-testid="version-item"][data-version-number="${number}"]`);
    // v3 has the long title, v4 the long request and no title, v5 a short title.
    await expect(item(3).getByTestId("version-title")).toHaveText(LONG_TITLE);
    await expect(item(4).getByTestId("version-title")).toHaveText(LONG_REQUEST);
    await expect(item(5).getByTestId("version-title")).toHaveText("Photo added");
    await expect(item(1).getByTestId("version-title")).toHaveText("First version");
    // Rows run edge to edge of the Versions area, no box around the list.
    const area = (await page.getByTestId("versions-area").boundingBox())!;
    const areaInner = await page
      .getByTestId("versions-area")
      .evaluate((node) => ({ width: node.clientWidth, left: node.clientLeft }));
    for (const box of await items.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().toJSON() as { x: number; width: number }),
    )) {
      expect(Math.abs(box.width - areaInner.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.x - (area.x + areaInner.left))).toBeLessThanOrEqual(1);
    }
    const list = await page.getByTestId("version-list").evaluate((node) => ({
      radius: getComputedStyle(node).borderTopLeftRadius,
      left: getComputedStyle(node).borderLeftWidth,
    }));
    expect(list).toEqual({ radius: "0px", left: "0px" });
    // No time or date on a row: what changed matters, not when.
    await expect(items.locator("time")).toHaveCount(0);
    // A title takes up to two lines: a short one shows in full, a long one
    // (or a long request standing in for it) is cut at the second line.
    const fit = (number: number) =>
      item(number)
        .getByTestId("version-title")
        .evaluate((node) => ({
          clamp: getComputedStyle(node).webkitLineClamp,
          cut: node.scrollHeight > node.clientHeight + 1,
        }));
    expect(await fit(5)).toEqual({ clamp: "2", cut: false });
    expect(await fit(3)).toEqual({ clamp: "2", cut: true });
    expect(await fit(4)).toEqual({ clamp: "2", cut: true });
    // Collapsed: no request, no summary, no Go back.
    await expect(item(4).getByTestId("version-summary")).toBeHidden();
    await expect(item(4).getByTestId("version-origin")).toBeHidden();
    await expect(item(4).getByRole("button", { name: "Go back to this" })).toBeHidden();

    // The arrow is a button: Enter opens, Space closes, with a focus ring.
    const toggle = item(4).getByTestId("version-toggle");
    await expect(toggle).toHaveAccessibleName("Show details of v4");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const details = item(4).getByTestId("version-details");
    await expect(toggle).toHaveAttribute("aria-controls", (await details.getAttribute("id"))!);
    await toggle.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    expect(await toggle.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(details.getByText("What you asked")).toBeVisible();
    await expect(details.getByTestId("version-origin")).toHaveText(LONG_REQUEST);
    await expect(details.getByText("What changed")).toBeVisible();
    await expect(details.getByTestId("version-summary")).toHaveText("layout version 4");
    await expect(details.getByRole("button", { name: "Go back to this" })).toBeVisible();

    // Several rows may be open; the others keep their height.
    await item(5).getByTestId("version-toggle").click();
    await expect(item(5).getByTestId("version-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(item(4).getByTestId("version-toggle")).toHaveAttribute("aria-expanded", "true");
    const closed = (await item(3).boundingBox())!.height;
    expect(Math.abs(closed - collapsed[0]!)).toBeLessThanOrEqual(1);

    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(details).toBeHidden();
    await expectNoPageScroll(page);
    await expectOwnScroll(page, page.getByTestId("versions-area"));
  });
}

// Other desktop sizes, down to the `lg` breakpoint: the same split, Send in
// the root box, no page scroll.
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
]) {
  test(`the desktop split at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
    await openReel(page, baseURL!, viewport);
    await expectNoPageScroll(page);
    await expectInsideRoot(page, page.getByRole("button", { name: "Send" }));
    await expectInsideRoot(page, page.getByRole("button", { name: "Upload a photo" }));
    await expectDesktopSplit(page);
    await expectOwnScroll(page, page.getByTestId("versions-area"));
    await expectNoPageScroll(page);
  });
}

test("one screen at 390x844 with tabs Edit, Versions and Library", async ({ page, baseURL }) => {
  await openReel(page, baseURL!, PHONE);
  await expectNoPageScroll(page);
  await expectInsideRoot(page, page.getByRole("button", { name: "Send" }));
  await expectInsideRoot(page, page.getByTestId("export-button"));
  await expectNoNotifyControl(page);

  const tabs = page.getByRole("tablist", { name: "Reel" });
  await expect(tabs).toBeVisible();
  const tab = (name: string) => tabs.getByRole("tab", { name });
  await expect(tabs.getByRole("tab")).toHaveText(["Edit", "Versions", "Library"]);
  await expect(page.getByTestId("status-area")).toHaveCount(0);
  await expect(page.getByTestId("step-line")).toHaveCount(0);
  const field = page.getByLabel("Ask for a change");

  await expect(tab("Edit")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("hyperframes-player")).toBeVisible();
  await expect(page.getByTestId("tracks")).toBeVisible();
  await expect(page.getByTestId("version-item").first()).toBeHidden();
  await expect(field).toBeVisible();
  // No visible label: the field is named by aria-label, and its placeholder
  // says what to ask for.
  await expect(page.getByText("Ask for a change", { exact: true })).toHaveCount(0);
  await expect(field).toHaveAttribute("placeholder", /^What should change\? For example:/);
  // Unchanged on a phone: the correction field pinned at the bottom of the
  // root box, the full width, under the Edit panel.
  const root = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    bottom: Math.min(
      document.documentElement.getBoundingClientRect().bottom,
      document.documentElement.clientHeight,
    ),
  }));
  const change = (await page.getByTestId("change-area").boundingBox())!;
  const editBox = (await page.getByTestId("edit-area").boundingBox())!;
  expect(Math.abs(change.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(change.width - root.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(change.y + change.height - root.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(change.y - (editBox.y + editBox.height))).toBeLessThanOrEqual(1);
  await expectSendAtBottomRight(page);

  await tab("Versions").click();
  await expect(tab("Versions")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("version-item").first()).toBeVisible();
  await expect(page.locator("hyperframes-player")).toBeHidden();
  await expect(field).toBeVisible();
  await expectNoPageScroll(page);
  await expectOwnScroll(page, page.getByTestId("versions-area"));

  await tab("Library").click();
  await expect(page.getByTestId("library-area")).toBeVisible();
  await expect(page.getByTestId("version-item").first()).toBeHidden();
  await expect(field).toBeVisible();
  await expectNoPageScroll(page);
  await expectInsideRoot(page, page.getByRole("button", { name: "Send" }));

  // Arrow keys move between the three tabs (WAI-ARIA tabs), wrapping at both ends.
  await tab("Library").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab("Edit")).toHaveAttribute("aria-selected", "true");
  await expect(tab("Edit")).toBeFocused();
  await expect(page.locator("hyperframes-player")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(tab("Library")).toHaveAttribute("aria-selected", "true");
  await expect(tab("Library")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab("Versions")).toHaveAttribute("aria-selected", "true");
});

test("tracks: rows at resolveTimeline's times, footage frames, nothing focusable", async ({
  page,
  baseURL,
}) => {
  await openReel(page, baseURL!, DESKTOP);
  const edit = await currentEdit();
  const resolved = resolveTimeline(edit, await fixtureTranscript());
  const tracks = page.getByTestId("tracks");

  const rows = tracks.locator("[data-track]");
  expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-track")))).toEqual([
    "footage",
    "behind",
    "overlays",
    "transitions",
  ]);
  for (const label of ["Footage", "Behind", "Accents", "Transitions"]) {
    await expect(tracks.getByText(label, { exact: true })).toBeVisible();
  }
  // The captions and sounds tracks are never shown, though the edit has captions.
  expect(edit.tracks.captions.length).toBeGreaterThan(0);
  for (const label of ["Captions", "Sounds"]) {
    await expect(tracks.getByText(label, { exact: true })).toHaveCount(0);
  }
  await expect(tracks.locator('[data-track="captions"], [data-track="sounds"]')).toHaveCount(0);

  const items = await tracks.getByTestId("track-item").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-item-id")!,
      track: el.closest("[data-track]")!.getAttribute("data-track"),
      start: el.getAttribute("data-start"),
      end: el.getAttribute("data-end"),
    })),
  );
  const trackOf = (id: string) =>
    (["footage", "overlays", "transitions"] as const).find((key) =>
      edit.tracks[key].some((item) => item.id === id),
    );
  const expected = [...resolved.entries()]
    .filter(([id]) => trackOf(id))
    .map(([id, span]) => ({
      id,
      track: trackOf(id)!,
      start: span.start.toFixed(3),
      end: span.end.toFixed(3),
    }));
  expect(items.length).toBeGreaterThan(0);
  expect([...items].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    [...expected].sort((a, b) => a.id.localeCompare(b.id)),
  );

  // The last footage clip's edges sit at start / duration and end / duration
  // of its lane.
  const last = edit.tracks.footage.at(-1)!;
  const lane = (await tracks
    .locator('[data-track="footage"] [data-testid="track-lane"]')
    .boundingBox())!;
  const clip = (await tracks.locator(`[data-item-id="${last.id}"]`).boundingBox())!;
  const span = resolved.get(last.id)!;
  expect(
    Math.abs(clip.x - (lane.x + (span.start / edit.duration) * lane.width)),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(clip.x + clip.width - (lane.x + (span.end / edit.duration) * lane.width)),
  ).toBeLessThanOrEqual(2);

  // The footage strip's frames come from the preview copy's sprite.
  const frame = tracks.locator('[data-track="footage"] [data-frame-index]').first();
  await expect(frame).toHaveCount(1);
  expect(await frame.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(
    /\/cache\/preview_copies\/[0-9a-f]{64}\/frames\.jpg/,
  );

  // The rows are read only: nothing in them takes focus or a drag. The ruler
  // is the timeline's one focusable element.
  await expect(tracks.locator("[data-track]").locator(FOCUSABLE)).toHaveCount(0);
  await expect(tracks.locator(FOCUSABLE)).toHaveCount(1);
  await expect(tracks.locator(FOCUSABLE)).toHaveAttribute("data-testid", "ruler");
});

// The player's position, read from the player itself.
function playerTime(page: Page): Promise<number> {
  return page
    .locator("hyperframes-player")
    .evaluate((el) => (el as unknown as { currentTime: number }).currentTime);
}

// The playhead line's centre x on the page.
async function playheadX(page: Page): Promise<number> {
  const line = (await page.getByTestId("playhead").locator("span").first().boundingBox())!;
  return line.x + line.width / 2;
}

// One frame of the player's runtime, in seconds.
async function frameSeconds(page: Page): Promise<number> {
  const fps = await page
    .locator("hyperframes-player")
    .evaluate((el) => (el as unknown as { _runtimeFps?: number })._runtimeFps ?? 0);
  return 1 / (fps > 0 ? fps : 30);
}

// Waits until a seek to `seconds` has settled and returns the player's time.
// The player first reads the asked-for time, then the runtime moves it to a
// frame boundary (2.0175 becomes 2.0), sooner or later depending on the
// machine. Settled: on a frame, within one frame of `seconds`, the same over
// three reads 100 ms apart, and (unless the pointer is still down on the
// ruler, where the playhead shows the pointer's time) the playhead on it.
async function settledTime(page: Page, seconds: number, held = false): Promise<number> {
  const frame = await frameSeconds(page);
  const reads: number[] = [];
  await expect
    .poll(
      async () => {
        const t = await playerTime(page);
        reads.push(t);
        const last = reads.slice(-3);
        const stable = last.length === 3 && last.every((read) => read === t);
        const onFrame = Math.abs(t / frame - Math.round(t / frame)) < 1e-6;
        const close = Math.abs(t - seconds) <= frame + 1e-6;
        if (!stable || !onFrame || !close) return false;
        if (held) return true;
        const shown = Number(await page.getByTestId("playhead").getAttribute("data-seconds"));
        return Math.abs(shown - t) <= 0.0005;
      },
      { intervals: [100], timeout: 10_000 },
    )
    .toBe(true);
  return reads.at(-1)!;
}

for (const [size, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", PHONE],
] as const) {
  test(`the ruler is the one scrubber at ${size}`, async ({ page, baseURL }) => {
    await openReel(page, baseURL!, viewport);
    const tracks = page.getByTestId("tracks");
    const slider = ruler(page);
    const duration = Number(await slider.getAttribute("data-duration"));
    expect(duration).toBeGreaterThan(1);
    const frame = await frameSeconds(page);
    // Settled on `seconds`, with the slider's value on the player's time.
    const near = async (seconds: number) => {
      const t = await settledTime(page, seconds);
      await expect(slider).toHaveAttribute("aria-valuenow", String(Number(t.toFixed(2))));
      return t;
    };

    // The control row has Play and the clock, and no Position slider; the
    // ruler is the page's one slider.
    const controlRow = page.getByRole("button", { name: "Play" }).locator("..");
    await expect(controlRow.getByTestId("preview-clock")).toBeVisible();
    await expect(controlRow.getByLabel("Position")).toHaveCount(0);
    await expect(page.locator('input[type="range"]')).toHaveCount(0);
    await expect(page.getByRole("slider")).toHaveCount(1);
    await expect(slider).toHaveAttribute("tabindex", "0");
    await expect(slider).toHaveAttribute("aria-valuemin", "0");
    await expect(slider).toHaveAttribute("aria-valuemax", String(Number(duration.toFixed(2))));
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await expect(slider).toHaveAttribute("aria-valuetext", `00:00 of ${formatClock(duration)}`);

    // One time axis: the ruler and every row's time area share their left
    // edge and width, measured from boxes.
    const rulerBox = (await slider.boundingBox())!;
    const lanes = tracks.getByTestId("track-lane");
    await expect(lanes).toHaveCount(4);
    for (const lane of await lanes.all()) {
      const box = (await lane.boundingBox())!;
      expect(Math.abs(box.x - rulerBox.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - rulerBox.width)).toBeLessThanOrEqual(1);
    }
    // At 0 the playhead sits on the ruler's left edge.
    expect(Math.abs((await playheadX(page)) - rulerBox.x)).toBeLessThanOrEqual(2);

    // A click on the ruler seeks there.
    for (const share of [0.25, 0.75]) {
      const point = await rulerPoint(page, share * duration);
      await page.mouse.click(point.x, point.y);
      await near(share * duration);
    }
    await expect(slider).toBeFocused();

    // Clicking a track row does nothing: read once the last seek has settled,
    // the time stays put (within a frame), far from the 5 px the row click
    // would mean on the shared axis.
    const before = await near(0.75 * duration);
    const lane = tracks.locator('[data-track="transitions"] [data-testid="track-lane"]');
    const laneBox = (await lane.boundingBox())!;
    await lane.click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(500);
    const after = await playerTime(page);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(frame);
    expect(Math.abs(after - (5 / laneBox.width) * duration)).toBeGreaterThan(duration / 4);

    // A drag keeps the playhead under the pointer, even once the player's
    // clock has settled on a frame, and keeps scrubbing once the pointer
    // leaves the ruler (pointer capture).
    const under = async (x: number) => {
      await expect.poll(async () => Math.abs((await playheadX(page)) - x)).toBeLessThanOrEqual(2);
    };
    const from = await rulerPoint(page, 0.2 * duration);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await under(from.x);
    await settledTime(page, 0.2 * duration, true);
    await under(from.x);
    for (const share of [0.35, 0.5, 0.65]) {
      const to = await rulerPoint(page, share * duration);
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await under(to.x);
      await settledTime(page, share * duration, true);
      await under(to.x);
      await expect
        .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
        .toBeCloseTo(share * duration, 2);
    }
    // Below the ruler and past its right end: still scrubbing, clamped to the
    // end, the playhead on the ruler's right edge.
    await page.mouse.move(rulerBox.x + rulerBox.width + 40, rulerBox.y + 60, { steps: 4 });
    await under(rulerBox.x + rulerBox.width);
    await settledTime(page, duration, true);
    await page.mouse.up();
    // Released: the playhead follows the player's clock (its last frame).
    const end = await near(duration);
    await under(rulerBox.x + (end / duration) * rulerBox.width);
    // A move no longer seeks.
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(500);
    expect(Math.abs((await playerTime(page)) - end)).toBeLessThanOrEqual(frame);

    // Keys: Home, arrows (1 s), Shift with an arrow (5 s), End. Each key
    // waits for the previous seek to settle, and each step is from the
    // settled time.
    await slider.focus();
    await page.keyboard.press("Home");
    let t = await near(0);
    expect(t).toBe(0);
    await expect(slider).toHaveAttribute("aria-valuetext", `00:00 of ${formatClock(duration)}`);
    await page.keyboard.press("ArrowRight");
    t = await near(Math.min(t + 1, duration));
    await page.keyboard.press("Shift+ArrowRight");
    t = await near(Math.min(t + 5, duration));
    await page.keyboard.press("ArrowLeft");
    t = await near(Math.max(t - 1, 0));
    await page.keyboard.press("End");
    t = await near(duration);
    await page.keyboard.press("Shift+ArrowLeft");
    await near(Math.max(t - 5, 0));

    await expectNoPageScroll(page);
  });

  test(`Play and Pause are one icon button and the clock is centred at ${size}`, async ({
    page,
    baseURL,
  }) => {
    await openReel(page, baseURL!, viewport);
    const toggle = page.getByTestId("play-toggle");
    await expect(toggle).toBeEnabled();
    // An icon and no visible text: the name comes from aria-label.
    await expect(toggle).toHaveText("");
    await expect(toggle.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(toggle).toHaveAccessibleName("Play");
    await expect(toggle).toHaveAttribute("title", "Play");
    // A tap target of at least 40x40, at the left of the control row.
    const box = (await toggle.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
    const clock = (await page.getByTestId("preview-clock").boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(clock.x);
    // No shape behind the icon on hover: the background stays transparent.
    await toggle.hover();
    expect(await toggle.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );

    // The clock sits on the control row's centre (within 2 px), whatever
    // stands left and right of it: two lines, the current time above the
    // total, with the times in the existing format.
    const row = (await toggle.locator("..").boundingBox())!;
    expect(Math.abs(clock.x + clock.width / 2 - (row.x + row.width / 2))).toBeLessThanOrEqual(2);
    const current = page.getByTestId("preview-clock-position");
    const total = page.getByTestId("preview-clock-duration");
    await expect(current).toHaveText("00:00");
    await expect(total).toHaveText(/^\d{2}:\d{2}$/);
    const currentBox = (await current.boundingBox())!;
    const totalBox = (await total.boundingBox())!;
    expect(currentBox.y + currentBox.height).toBeLessThanOrEqual(totalBox.y + 0.5);
    // The row is no taller than the 40 px button.
    expect(row.height).toBeLessThanOrEqual(box.height + 0.5);

    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Pause");
    await expect(toggle).toHaveAttribute("title", "Pause");
    await expect(toggle).toHaveText("");
    await expect(page.locator('[data-intent="playing"]')).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Play");
    await expect(page.locator('[data-intent="paused"]')).toBeVisible();
    await expectNoPageScroll(page);
  });

  test(`Expand and Collapse the preview at ${size}`, async ({ page, baseURL }) => {
    await openReel(page, baseURL!, viewport);
    const expand = page.getByTestId("preview-expand");
    const toggle = page.getByTestId("play-toggle");
    const clock = page.getByTestId("preview-clock");
    const zones = page.getByRole("button", { name: "Zones" });
    const frame = page.locator("hyperframes-player").locator("..");
    const row = toggle.locator("..");
    // The player element itself, tagged to tell a remount from a toggle.
    await page
      .locator("hyperframes-player")
      .evaluate((el) => el.setAttribute("data-e2e-mount", "first"));

    // Collapsed on open: an icon button with no text at the right end of the
    // control row, after Zones.
    await expect(expand).toHaveAccessibleName("Expand preview");
    await expect(expand).toHaveAttribute("title", "Expand preview");
    await expect(expand).toHaveAttribute("aria-pressed", "false");
    await expect(expand).toHaveText("");
    await expect(expand.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    const box = (await expand.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
    const rowBox = (await row.boundingBox())!;
    expect(Math.abs(box.x + box.width - (rowBox.x + rowBox.width))).toBeLessThanOrEqual(1);
    const zonesBox = (await zones.boundingBox())!;
    expect(zonesBox.x + zonesBox.width).toBeLessThanOrEqual(box.x + 0.5);
    await expect(page.getByTestId("tracks")).toBeVisible();
    await expect(page.getByTestId("ruler")).toBeVisible();
    const collapsedFrame = (await frame.boundingBox())!;

    // Playing, then expanded with the keyboard: playback goes on.
    await toggle.click();
    await expect(page.locator('[data-intent="playing"]')).toBeVisible();
    await expect(page.locator('[data-preview="ready"]')).toBeVisible({ timeout: 10_000 });
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(expand).toHaveAccessibleName("Collapse preview");
    await expect(expand).toHaveAttribute("title", "Collapse preview");
    await expect(expand).toHaveAttribute("aria-pressed", "true");
    await expect(expand).toBeFocused();

    // Expanded: no tracks, no ruler, no Zones; Play or Pause,
    // the clock (still centred) and the button stay, the preview is taller
    // and still 9:16, and the page does not scroll.
    await expect(page.getByTestId("tracks")).toHaveCount(0);
    await expect(page.getByTestId("ruler")).toHaveCount(0);
    await expect(zones).toHaveCount(0);
    await expect(toggle).toBeVisible();
    await expect(clock).toBeVisible();
    await expect(toggle).toHaveAccessibleName("Pause");
    await expect(page.locator('[data-intent="playing"]')).toBeVisible();
    const expandedRow = (await row.boundingBox())!;
    const clockBox = (await clock.boundingBox())!;
    expect(
      Math.abs(clockBox.x + clockBox.width / 2 - (expandedRow.x + expandedRow.width / 2)),
    ).toBeLessThanOrEqual(2);
    const expandedBox = (await expand.boundingBox())!;
    expect(
      Math.abs(expandedBox.x + expandedBox.width - (expandedRow.x + expandedRow.width)),
    ).toBeLessThanOrEqual(1);
    const expandedFrame = (await frame.boundingBox())!;
    expect(expandedFrame.height).toBeGreaterThan(collapsedFrame.height + 20);
    expect(Math.abs(expandedFrame.width / expandedFrame.height - 9 / 16)).toBeLessThan(0.01);
    const area = (await page.getByTestId("edit-area").boundingBox())!;
    expect(
      Math.abs(expandedFrame.x + expandedFrame.width / 2 - (area.x + area.width / 2)),
    ).toBeLessThanOrEqual(2);
    await expectNoPageScroll(page);
    // The clock keeps running: the same player, never paused or rebuilt.
    const t1 = await playerTime(page);
    await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(t1);
    await expect(page.locator('hyperframes-player[data-e2e-mount="first"]')).toHaveCount(1);

    // Collapsed with Space: everything is back, still playing in the same player.
    await page.keyboard.press("Space");
    await expect(expand).toHaveAccessibleName("Expand preview");
    await expect(expand).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("tracks")).toBeVisible();
    await expect(page.getByTestId("ruler")).toBeVisible();
    await expect(zones).toBeVisible();
    expect(Math.abs((await frame.boundingBox())!.height - collapsedFrame.height)).toBeLessThan(1);
    await expect(page.locator('[data-intent="playing"]')).toBeVisible();
    const t2 = await playerTime(page);
    await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(t2);
    await expect(page.locator('hyperframes-player[data-e2e-mount="first"]')).toHaveCount(1);
    await expectNoPageScroll(page);

    // Paused stays paused through a toggle, at the same time.
    await toggle.click();
    await expect(page.locator('[data-intent="paused"]')).toBeVisible();
    const paused = await settledTime(page, await playerTime(page));
    await expand.click();
    await expect(page.locator('[data-intent="paused"]')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await playerTime(page)).toBe(paused);
    await expand.click();
    await expect(page.getByTestId("tracks")).toBeVisible();
  });
}

test("the playhead follows the player's clock", async ({ page, baseURL }) => {
  await openReel(page, baseURL!, DESKTOP);
  const playhead = page.getByTestId("playhead");
  await expect(playhead).toHaveAttribute("data-seconds", "0.000");
  const startTransform = await playhead.evaluate((el) => (el as HTMLElement).style.transform);

  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(async () => Number(await playhead.getAttribute("data-seconds")), { timeout: 10_000 })
    .toBeGreaterThan(0.5);
  await page.getByRole("button", { name: "Pause" }).click();
  expect(await playhead.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(
    startTransform,
  );
  // The pause reaches the player's frame by message, so a clock tick already
  // in flight can still land: wait for the playhead to settle, then it stays.
  let paused: string | null = null;
  await expect
    .poll(
      async () => {
        const previous = paused;
        paused = await playhead.getAttribute("data-seconds");
        return paused === previous;
      },
      { intervals: [250], timeout: 5_000 },
    )
    .toBe(true);
  await page.waitForTimeout(500);
  expect(await playhead.getAttribute("data-seconds")).toBe(paused);
});

test("no Undo or Redo: the preview shows the current version at both sizes", async ({
  page,
  baseURL,
}) => {
  const { data, error } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reel!.reelId)
    .single<{ current_version_id: string }>();
  if (error || !data) throw new Error(`reel not read: ${error?.message}`);
  const currentId = data.current_version_id;
  const newest = (await versionRows()).at(-1)!;
  expect(currentId).toBe(newest.id);

  for (const viewport of [DESKTOP, PHONE]) {
    await openReel(page, baseURL!, viewport);
    for (const name of ["Undo", "Redo"]) {
      await expect(
        page.getByRole("button", { name, exact: true, includeHidden: true }),
      ).toHaveCount(0);
    }
    await expect(
      page.locator(`[data-preview-version="${currentId}"][data-preview="ready"]`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(`[data-testid="version-item"][data-version-number="${newest.number}"]`),
    ).toHaveAttribute("data-current", "true");
    await expect(page.locator('[data-testid="version-item"][data-selected]')).toHaveCount(0);
    await expect(page.getByTestId("version-showing")).toHaveCount(0);
  }
});
