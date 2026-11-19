import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA_PRESET,
  hookReveal,
  parseEdit,
  resolveTimeline,
  transcriptSchema,
  typedCount,
} from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { type Page, expect, test } from "@playwright/test";
import { unchangedAnswerScript } from "../test-support/ai-script.ts";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { type ProcessedReel, seedProcessedReel } from "../test-support/pipeline-cache.ts";
import { routePreviewCdn } from "../test-support/preview-routes.ts";
import { seekOnRuler } from "../test-support/ruler.ts";
import { placedQuestion } from "../test-support/transitions.ts";
import { saveTestVersion } from "../test-support/versions.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

// The owner fixes words in place in the Edit mode (app_docs/owner-edits.md;
// owner decisions 2026-11-19): a text edit changes only the element edited,
// its time stays tied to the spoken words, and Save keeps it in a new version
// with a learning row. A caption's fix is also a transcript correction of the
// reel: a Start over builds from the transcript with it, and the AI reads it.
// The fixture clip's first four words, "this is a short",
// show as captions; an accent added by hand (`accent-9`) shows the spoken word
// "short" (w0004) too, so the same spoken word is on screen in two elements.

const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;
const CAPTIONS = ["cw0001", "cw0002", "cw0003", "cw0004"];
const ACCENT = "accent-9";
const BLOCK = "block_cw0001";
const TRANSCRIPT = new URL("../../../fixtures/pipeline/retime/transcript.json", import.meta.url);
// Set to a folder to keep screenshots of the editor (never in CI).
const SHOTS = process.env.OWNER_EDIT_SHOTS;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let reel: ProcessedReel | null = null;
let page: Page;
let edit: Edit;
let placedVersionId: string;
const extraKeys: string[] = [];
// Where the Start over's scripted AI answer is written.
let scriptDir: string;
// The hook as the version draws it: no edit of another text may change it.
let hookText: string;
// The owner's words for the hook: as many letters as the version's own.
const HOOK_TEXT = "A brief test for the real studio";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "owner-edit-text");
  reel = await seedProcessedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX });
  // The committed version placed by the engine with a QUESTION, saved with the
  // engine's record the way the decide step saves it.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const stored = await storage.get(reel.versionKey);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(stored!)),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  const placed = await placedQuestion(parsed.edit, transcript);
  // An accent on the spoken word "short", which its caption shows too: placed
  // by hand in a band of the safe zone no other text of the version is in.
  const taken = [
    ...placed.edit.tracks.overlays,
    ...placed.edit.tracks.captions.filter((item) => item.position),
  ].map((item) => ({
    top: item.position!.y - 60,
    bottom: item.position!.y + (item.size ?? 110) * ((item.breaks?.length ?? 0) + 1) + 60,
  }));
  const y = [320, 560, 800, 1040, 1280].find((top) =>
    taken.every((band) => top + 80 < band.top || top > band.bottom),
  );
  if (y === undefined) throw new Error("no free band for the accent");
  edit = {
    ...placed.edit,
    tracks: {
      ...placed.edit.tracks,
      overlays: [
        ...placed.edit.tracks.overlays,
        {
          id: ACCENT,
          kind: "accent",
          start: { word: "w0004" },
          end: { word: "w0004", edge: "end", offset: 0.5 },
          words: ["w0004"],
          position: { x: 440, y, align: "left" },
          size: 80,
        },
      ],
    },
  };
  const saved = await saveTestVersion({
    admin,
    storage,
    prefix: CACHE_PREFIX,
    reelId: reel.reelId,
    edit,
    changeSummary: "captions, a question and an accent",
    engineRecord: placed.record,
  });
  placedVersionId = saved.id;
  extraKeys.push(saved.key);
  scriptDir = await mkdtemp(join(tmpdir(), "owner-edit-text-"));
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
  });
  page = await context.newPage();
  await routePreviewCdn(page);
});

test.afterAll(async () => {
  await page?.context().close();
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true });
  if (reel) {
    const { data } = await admin.from("versions").select("r2_key").eq("reel_id", reel.reelId);
    const keys = [
      ...reel.keys,
      ...extraKeys,
      ...((data ?? []) as { r2_key: string }[]).map((row) => row.r2_key),
    ];
    for (const key of new Set(keys)) await storage.delete(key);
  }
  if (owner) await deleteTestUser(admin, owner.id);
});

function moveBox(id: string) {
  return page.locator(`[data-testid="move-box"][data-component-id="${id}"]`);
}

async function ready() {
  await expect(page.locator('[data-preview="ready"][data-page="shown"]')).toBeVisible({
    timeout: 30_000,
  });
}

// What the page on screen draws for some elements: each one's text, as its
// word elements (a revealed text's `.q`, the typed hook's `.w`, each holding
// its letters) or its own lines hold it.
async function texts(ids: readonly string[]): Promise<string[]> {
  return page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
    .locator("#root")
    .evaluate(
      (root, wanted) =>
        wanted.map((id) => {
          const el = root.querySelector<HTMLElement>(`[id="${id}"]`);
          if (!el) return "(none)";
          const words = [...el.querySelectorAll(".q, .w")].map((word) => word.textContent ?? "");
          return words.length > 0 ? words.join(" ") : (el.innerText ?? "").replace(/\s+/g, " ");
        }),
      [...ids],
    );
}

// Whether an element's words show now: the text's own opacity and each word's.
async function shownWords(id: string): Promise<string> {
  return page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
    .locator(`[id="${id}"]`)
    .evaluate((el) =>
      getComputedStyle(el).opacity === "1"
        ? [...el.querySelectorAll<HTMLElement>(".q")]
            .filter((word) => getComputedStyle(word).opacity === "1")
            .map((word) => word.textContent)
            .join(" ")
        : "",
    );
}

async function place(id: string) {
  return page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
    .locator(`[id="${id}"]`)
    .evaluate((el) => {
      const { left, top, fontSize } = (el as HTMLElement).style;
      return {
        x: Number.parseFloat(left),
        y: Number.parseFloat(top),
        fontSize: Number.parseFloat(fontSize),
      };
    });
}

async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
}

const field = () => page.getByTestId("move-text-input");

test("Edit text on the selected caption block opens a field with the words on screen; Enter fixes one word, in that caption only", async ({
  baseURL,
}) => {
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.goto(`/studio/reels/${reel!.reelId}`);
  await expect(
    page.locator(`[data-preview-version="${placedVersionId}"][data-preview="ready"]`),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("edit-toggle").click();
  await expect(page.getByTestId("move-layer")).toBeVisible();
  hookText = (await texts(["hook"]))[0]!;
  expect(hookText.length).toBeGreaterThan(0);
  expect(await texts([...CAPTIONS, ACCENT])).toEqual(["this", "is", "a", "short", "short"]);
  await page.getByTestId("move-pick").selectOption(BLOCK);
  const box = moveBox(BLOCK);
  await expect(box).toHaveAttribute("data-selected", "true");
  const before = await place("cw0001");
  await expect(page.getByTestId("move-save")).toBeDisabled();
  await box.getByTestId("move-edit-text").click();
  await expect(field()).toBeFocused();
  await expect(field()).toHaveValue("this is a short");
  await expect(field()).toHaveAccessibleName("Text of this captions");
  await expect(page.getByTestId("move-text-count")).toContainText("15 of 45 characters");
  await shot("text-1-field-open.png");
  await field().fill("this is a brief");
  await field().press("Enter");
  await expect(field()).toHaveCount(0);
  // At once, on the page already on screen: the caption's own word element.
  expect((await texts(["cw0004"]))[0]).toBe("brief");
  await ready();
  // The caption shows the owner's word; the accent on the same spoken word,
  // the hook and the other captions keep theirs.
  expect(await texts([...CAPTIONS, ACCENT, "hook"])).toEqual([
    "this",
    "is",
    "a",
    "brief",
    "short",
    hookText,
  ]);
  // The block keeps its top and its size.
  const after = await place("cw0001");
  expect(after.y).toBe(before.y);
  expect(after.fontSize).toBe(before.fontSize);
  await expect(page.getByTestId("move-save")).toBeEnabled();
  await expect(page.getByTestId("move-pick").locator("option")).toContainText([
    /^Captions: this is a brief/,
  ]);
  await shot("text-2-caption-fixed.png");
});

test("double-clicking a text edits it in place: more words on the same spoken word, the caption of that word unchanged", async () => {
  await page.getByTestId("move-pick").selectOption(ACCENT);
  const box = moveBox(ACCENT);
  await expect(box).toHaveAttribute("data-selected", "true");
  const before = await place(ACCENT);
  await box.dblclick();
  await expect(field()).toBeFocused();
  await expect(field()).toHaveValue("short");
  // Three times the original is 15 characters; a short text may still take 40.
  await expect(page.getByTestId("move-text-count")).toContainText("5 of 40 characters");
  await field().fill("  short   and sweet ");
  // A click outside the field ends the edit and keeps the text.
  await page.getByTestId("move-bar").click({ position: { x: 5, y: 5 } });
  await expect(field()).toHaveCount(0);
  await ready();
  expect(await texts([ACCENT, "cw0004", "hook"])).toEqual(["short and sweet", "brief", hookText]);
  const after = await place(ACCENT);
  expect(after.y).toBe(before.y);
  expect(after.fontSize).toBe(before.fontSize);
  // All three words come in on the one spoken word, "short" (0.552 s): none
  // before it, all of them after it.
  await seekOnRuler(page, 0.52);
  await expect.poll(() => shownWords(ACCENT)).toBe("");
  await seekOnRuler(page, 0.7);
  await expect.poll(() => shownWords(ACCENT)).toBe("short and sweet");
  await shot("text-3-accent-edited.png");
});

test("Escape drops a text edit, an empty text is refused with its reason, and a text too long cannot be typed", async () => {
  await page.getByTestId("move-pick").selectOption("hook");
  const box = moveBox("hook");
  await expect(box).toHaveAttribute("data-selected", "true");
  await box.getByTestId("move-edit-text").click();
  await expect(field()).toHaveValue(hookText);
  await field().fill("something else entirely");
  await field().press("Escape");
  await expect(field()).toHaveCount(0);
  expect((await texts(["hook"]))[0]).toBe(hookText);
  await box.dblclick();
  await field().fill("   ");
  await field().press("Enter");
  await expect(page.getByTestId("move-status")).toHaveText(
    "A text cannot be empty. The text stays as it was",
  );
  expect((await texts(["hook"]))[0]).toBe(hookText);
  // The field holds no more than the limit: three times the hook's characters.
  await box.getByTestId("move-edit-text").click();
  const limit = Math.max(40, hookText.length * 3);
  await expect(field()).toHaveAttribute("maxlength", String(limit));
  await field().press("Escape");
  await expect(field()).toHaveCount(0);
});

test("the hook's words are fixed in place, and the new text is typed letter by letter with its caret", async () => {
  await page.getByTestId("move-pick").selectOption("hook");
  const box = moveBox("hook");
  await expect(box).toHaveAttribute("data-selected", "true");
  const before = await place("hook");
  await box.getByTestId("move-edit-text").click();
  await expect(field()).toHaveValue(hookText);
  await field().fill(HOOK_TEXT);
  await field().press("Enter");
  await expect(field()).toHaveCount(0);
  await ready();
  // Only the hook: the caption and the accent keep the owner's earlier words.
  expect(await texts(["hook", "cw0004", ACCENT])).toEqual([HOOK_TEXT, "brief", "short and sweet"]);
  const after = await place("hook");
  expect(after.y).toBe(before.y);
  expect(after.fontSize).toBe(before.fontSize);

  // The new text is typed like any hook: every letter an element of its own,
  // each but the last holding its caret, spread over the first 60% of the
  // hook's window, which the edit did not change.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const span = resolveTimeline(edit, transcript).get("hook")!;
  const reveal = hookReveal(HOOK_TEXT, span);
  const letters = reveal.map((letter) => letter.text).join("");
  expect(letters).toBe("Abrieftestfortherealstudio");
  const hook = page
    .frameLocator('hyperframes-player[data-page="shown"] iframe')
    .locator('[id="hook"]');
  await expect(hook.locator(".ch")).toHaveCount(reveal.length);
  await expect(hook.locator(".ch > .cr")).toHaveCount(reveal.length - 1);
  // The letters and the carets on screen, read with the page's own time.
  const read = () =>
    hook.evaluate((el) => {
      const view = el.ownerDocument.defaultView!;
      const timelines = (view as unknown as { __timelines: Record<string, { time(): number }> })
        .__timelines;
      const on = (node: Element) => view.getComputedStyle(node).opacity === "1";
      const typed = on(el) ? [...el.querySelectorAll(".ch")].filter(on) : [];
      return {
        time: timelines.main!.time(),
        shown: typed.map((letter) => letter.textContent).join(""),
        carets: typed.filter((letter) => [...letter.querySelectorAll(".cr")].some(on)).length,
      };
    });
  const typedNear = async (target: number) => {
    await seekOnRuler(page, target);
    await expect.poll(async () => Math.abs((await read()).time - target)).toBeLessThan(0.05);
    const { time, shown, carets } = await read();
    // A seek rests on a frame of the reel: it must be clear of any letter's
    // moment (a letter cuts in over 1 ms).
    expect(reveal.every((letter) => Math.abs(letter.at - time) > 0.002)).toBe(true);
    const count = typedCount(reveal, time);
    expect(shown).toBe(letters.slice(0, count));
    // One caret, after the last typed letter, until the text is fully typed.
    expect(carets).toBe(count > 0 && count < reveal.length ? 1 : 0);
    return count;
  };
  // A frame of the reel (30 a second) about a third of the way in, clear of
  // every letter's moment: part of the text is typed, one caret after it.
  // Then past 60% of the window: all of it, and no caret.
  const frames = Array.from({ length: 30 }, (_, index) => (index + 1) / 30);
  const part = frames.find(
    (frame) =>
      frame > reveal[8]!.at && reveal.every((letter) => Math.abs(letter.at - frame) > 0.01),
  )!;
  const typed = await typedNear(part + 0.005);
  expect(typed).toBeGreaterThan(8);
  expect(typed).toBeLessThan(reveal.length);
  const typedAt = reveal.at(-1)!.at;
  expect(typedAt).toBeCloseTo(span.start + (span.end - span.start) * 0.6, 3);
  expect(await typedNear(typedAt + 0.3)).toBe(reveal.length);
  await shot("text-3b-hook-typed.png");
});

test("Save keeps the text edits in a new version Edited by you, with a learning row for each, and the words still follow the voice", async () => {
  await page.getByTestId("move-save").click();
  await expect(page.getByTestId("move-status")).toHaveText("Saving your changes");
  const jobs = async () => {
    const { data } = await admin
      .from("jobs")
      .select("owner_edit")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "owner_edit");
    return (data ?? []) as {
      owner_edit: { moves: unknown[]; texts: { id: string; part?: string; text: string }[] };
    }[];
  };
  await expect.poll(async () => (await jobs()).length).toBe(1);
  const payload = (await jobs())[0]!.owner_edit;
  expect(payload.texts).toEqual([
    { id: BLOCK, part: "cw0001", text: "this is a brief" },
    { id: ACCENT, text: "short and sweet" },
    { id: "hook", text: HOOK_TEXT },
  ]);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, edited_from_id, r2_key")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as { id: string; edited_from_id: string | null; r2_key: string };
  expect(saved.edited_from_id).toBe(placedVersionId);
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  await expect(page.getByTestId("move-layer")).toHaveCount(0);
  await expect(page.getByText("Edited by you").first()).toBeVisible();
  // The saved version draws the owner's words, and only where they were typed.
  expect(await texts([...CAPTIONS, ACCENT, "hook"])).toEqual([
    "this",
    "is",
    "a",
    "brief",
    "short and sweet",
    HOOK_TEXT,
  ]);
  // The stored edit: the one caption, the accent and the hook carry the text; their
  // spoken words and their times are the edited version's.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const stored = parseEdit(
    JSON.parse(new TextDecoder().decode((await storage.get(saved.r2_key))!)),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!stored.ok) throw new Error(stored.reasons.join("; "));
  const was = new Map(edit.tracks.captions.map((item) => [item.id, item]));
  for (const item of stored.edit.tracks.captions) {
    const old = was.get(item.id)!;
    expect(item.text).toBe(item.id === "cw0004" ? "brief" : old.text);
    expect([item.words, item.start, item.end]).toEqual([old.words, old.start, old.end]);
  }
  const accent = stored.edit.tracks.overlays.find((item) => item.id === ACCENT)!;
  const oldAccent = edit.tracks.overlays.find((item) => item.id === ACCENT)!;
  expect(accent.text).toBe("short and sweet");
  expect([accent.words, accent.start, accent.end]).toEqual([
    oldAccent.words,
    oldAccent.start,
    oldAccent.end,
  ]);
  // The hook: its text, its window as it was; it is tied to no spoken word.
  const hook = stored.edit.tracks.overlays.find((item) => item.id === "hook")!;
  const oldHook = edit.tracks.overlays.find((item) => item.id === "hook")!;
  expect(hook.text).toBe(HOOK_TEXT);
  expect([hook.words, hook.start, hook.end, hook.size]).toEqual([
    undefined,
    oldHook.start,
    oldHook.end,
    oldHook.size,
  ]);
  const others = (items: Edit["tracks"]["overlays"]) =>
    items.filter((item) => item.id !== ACCENT && item.id !== "hook");
  expect(others(stored.edit.tracks.overlays)).toEqual(others(edit.tracks.overlays));
  // The caption's new word still comes in as "short" is spoken (0.552 s).
  await seekOnRuler(page, 0.52);
  await expect.poll(() => shownWords("cw0003")).toBe("a");
  expect(await shownWords("cw0004")).toBe("");
  await seekOnRuler(page, 0.7);
  await expect.poll(() => shownWords("cw0004")).toBe("brief");
  await shot("text-4-saved.png");

  const { data: rows } = await admin
    .from("owner_texts")
    .select("item, part, component, variant, before_text, after_text, words, word_ids")
    .eq("reel_id", reel!.reelId)
    .order("item");
  expect(rows).toEqual([
    {
      item: ACCENT,
      part: "",
      component: "ACCENT",
      variant: null,
      before_text: "short",
      after_text: "short and sweet",
      words: "short",
      word_ids: ["w0004"],
    },
    {
      item: BLOCK,
      part: "cw0001",
      component: "CAPTION",
      variant: "caption/default",
      before_text: "this is a short",
      after_text: "this is a brief",
      words: "This is a short",
      word_ids: ["w0001", "w0002", "w0003", "w0004"],
    },
    {
      item: "hook",
      part: "",
      component: "HOOK",
      variant: "hook/typed",
      before_text: hookText,
      after_text: HOOK_TEXT,
      words: "",
      word_ids: [],
    },
  ]);
  // The caption's fix is a transcript correction of the reel, by its spoken
  // word; the accent's and the hook's texts are theirs only.
  const { data: corrections } = await admin
    .from("owner_word_corrections")
    .select("word_id, text, original_text, owner_id")
    .eq("reel_id", reel!.reelId);
  expect(corrections).toEqual([
    { word_id: "w0004", text: "brief", original_text: "short", owner_id: owner.id },
  ]);
});

test("a font pair change keeps the caption fix: the new version is set in the new pair and still shows the owner's word", async () => {
  await page.getByTestId("font-pair-bold").click();
  const relayouts = async () => {
    const { data } = await admin
      .from("jobs")
      .select("status, font_pair")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "relayout");
    return data ?? [];
  };
  await expect.poll(relayouts).toEqual([{ status: "queued", font_pair: "bold" }]);
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);
  expect(await relayouts()).toEqual([{ status: "done", font_pair: "bold" }]);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, r2_key, engine_record")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as {
    id: string;
    r2_key: string;
    engine_record: { item: string; rule: string; outcome: string; reason: string }[];
  };
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  // The owner's word is still on its caption, in the new pair.
  expect(await texts(CAPTIONS)).toEqual(["this", "is", "a", "brief"]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const stored = parseEdit(
    JSON.parse(new TextDecoder().decode((await storage.get(saved.r2_key))!)),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!stored.ok) throw new Error(stored.reasons.join("; "));
  expect(stored.edit.font_pair).toBe("bold");
  expect(stored.edit.tracks.captions.find((item) => item.id === "cw0004")!.text).toBe("brief");
  expect(stored.edit.owner!.texts).toContain("cw0004");
  // The accent was made by hand for this spec and is in no AI answer, and
  // this reel's AI answer wrote no hook, so the placement made again has
  // neither: their texts could not be kept, and the version's record says so
  // (an edit is never lost silently).
  const lost = saved.engine_record.filter(
    (note) => note.rule === "owner-edit" && note.outcome === "dropped",
  );
  expect(lost.map((note) => note.item)).toEqual([ACCENT, "hook"]);
  expect(lost[0]!.reason).toMatch(/^your text "short and sweet" could not be kept: /);
  expect(lost[1]!.reason).toMatch(
    /^your text "A brief test for the real studio" could not be kept: /,
  );
  const { data: steps } = await admin
    .from("steps")
    .select("name, summary")
    .eq("reel_id", reel!.reelId)
    .eq("name", "relayout");
  expect((steps ?? []).map((step) => (step as { summary: string }).summary).join(" ")).toMatch(
    /1 of your edits kept, 2 of your edits could not be kept/,
  );
  await shot("text-5-font-pair.png");
});

test("Start over builds from the transcript with the caption's correction: the AI reads it, the captions show it, and no other edit is carried", async () => {
  const startOver = page
    .locator('section[aria-labelledby="versions-heading"]')
    .getByRole("button", { name: "Start over" });
  await expect(startOver).toBeEnabled({ timeout: 10_000 });
  await startOver.click();
  const queued = async () => {
    const { data } = await admin
      .from("jobs")
      .select("status")
      .eq("reel_id", reel!.reelId)
      .eq("kind", "start_over");
    return (data ?? []).map((job) => (job as { status: string }).status);
  };
  await expect.poll(queued).toEqual(["queued"]);
  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: await unchangedAnswerScript(scriptDir),
  });
  expect(worker.code, worker.output).toBe(0);
  expect(await queued()).toEqual(["done"]);

  const { data: versions } = await admin
    .from("versions")
    .select("id, number, r2_key, engine_record")
    .eq("reel_id", reel!.reelId)
    .order("number");
  const saved = versions!.at(-1) as {
    id: string;
    r2_key: string;
    engine_record: { item: string; rule: string }[];
  };
  await expect(page.locator(`[data-preview-version="${saved.id}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await ready();
  // The new version's captions show the owner's word on its spoken word.
  expect(await texts(CAPTIONS)).toEqual(["this", "is", "a", "brief"]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(TRANSCRIPT, "utf8")));
  const stored = parseEdit(
    JSON.parse(new TextDecoder().decode((await storage.get(saved.r2_key))!)),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!stored.ok) throw new Error(stored.reasons.join("; "));
  expect(stored.edit.tracks.captions.find((item) => item.id === "cw0004")!.text).toBe("brief");
  // Only the correction is the owner's in the new version: the hook is the
  // AI's again, the hand-made accent is gone, and nothing is noted as kept or
  // lost (a Start over carries no place, size or element text).
  expect(stored.edit.owner).toEqual({ placed: [], texts: ["cw0004"] });
  const hook = stored.edit.tracks.overlays.find((item) => item.kind === "hook")!;
  expect(hook.text).not.toBe(HOOK_TEXT);
  expect(stored.edit.tracks.overlays.some((item) => item.id === ACCENT)).toBe(false);
  expect(saved.engine_record.filter((note) => note.rule === "owner-edit")).toEqual([]);
  // What the AI was sent: the transcript with the owner's word, in both calls.
  const record = JSON.parse(
    new TextDecoder().decode(
      (await storage.get(`${CACHE_PREFIX}reels/${reel!.reelId}/versions/${saved.id}.ai.json`))!,
    ),
  ) as { calls: { role: string; prompt: string }[] };
  expect(record.calls.map((call) => call.role)).toEqual(["hook", "decide"]);
  expect(record.calls[0]!.prompt).toContain("This is a brief test clip");
  expect(record.calls[0]!.prompt).not.toContain("short");
  expect(record.calls[1]!.prompt).toContain('"text": "brief"');
  expect(record.calls[1]!.prompt).not.toContain('"text": "short"');
  const { data: steps } = await admin
    .from("steps")
    .select("name, summary")
    .eq("reel_id", reel!.reelId)
    .eq("name", "decide")
    .order("started_at");
  const summary = (steps ?? []).map((step) => (step as { summary: string }).summary).at(-1)!;
  expect(summary).toMatch(/started over from version 1, 1 word correction of yours kept/);
  expect(summary).not.toMatch(/your edits/);
  await shot("text-6-start-over.png");
});
