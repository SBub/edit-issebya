import { readFile, stat } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { type Transcript, ISSEBYA, parseEdit } from "@edit-issebya/edit";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { eventsNamed, recordEvents } from "./events.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { PIPELINE_FIXTURES, readManifest, seedPipelineCache } from "../test-support/pipeline.ts";
import { claimableJobIds, runWorkerOnce } from "../test-support/worker.ts";

const CLIP = new URL("../../../fixtures/footage/short-speech.mp4", import.meta.url).pathname;
// This run's own cache folder: the worker reads it through R2_KEY_PREFIX.
const CACHE_PREFIX = `e2e-${crypto.randomUUID()}/`;

const admin = localSupabaseAdmin();
const storage = fakeStorage({
  root: e2eStorageRoot(new URL(".", import.meta.url).pathname),
  uploadUrlBase: "",
});
let owner: { id: string; email: string };
let sourceKey: string | null = null;
const versionKeys: string[] = [];
const seededKeys: string[] = [];

test.beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "upload");
});

test.afterAll(async () => {
  if (sourceKey) await storage.delete(sourceKey);
  for (const key of versionKeys) await storage.delete(key);
  for (const key of seededKeys) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("an uploaded clip goes through every pipeline step and the page updates live", async ({
  page,
  baseURL,
}) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  const clipBytes = (await stat(CLIP)).size;
  const events = await recordEvents(page);
  // PostHog never initialises under Playwright: no request may reach it.
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  const posthogRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.host.includes("posthog") || (posthogHost && request.url().startsWith(posthogHost))) {
      posthogRequests.push(request.url());
    }
  });
  await page.goto(await signInLink(admin, owner.email, baseURL!));
  await page.getByLabel("Clip").setInputFiles(CLIP);
  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page).toHaveURL(
    /\/studio\/reels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  const reelId = new URL(page.url()).pathname.split("/").pop()!;
  await expect
    .poll(() => eventsNamed(events, "studio_footage_uploaded"))
    .toEqual([
      { event: "studio_footage_uploaded", properties: { app: "studio", reel_id: reelId } },
    ]);

  const { data: reel } = await admin
    .from("reels")
    .select("status, source_bytes, source_key, source_name")
    .eq("id", reelId)
    .single();
  expect(reel).toMatchObject({
    status: "uploaded",
    source_bytes: clipBytes,
    source_name: "short-speech.mp4",
  });
  sourceKey = reel!.source_key as string;
  const { data: jobs } = await admin.from("jobs").select("kind, status").eq("reel_id", reelId);
  expect(jobs).toEqual([{ kind: "process", status: "queued" }]);
  expect(await storage.head(sourceKey)).toMatchObject({ bytes: clipBytes });

  await expect(page.locator('[data-realtime="ready"]')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "marker";
  });

  seededKeys.push(...(await seedPipelineCache(storage, CACHE_PREFIX)));
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX });
  expect(worker.code, worker.output).toBe(0);

  await expect(page.getByTestId("job-status")).toHaveText("done", { timeout: 10_000 });
  // Every step's outputs were already stored: each is a hit, nothing ran.
  await expect(page.getByTestId("step-line")).toHaveText(
    [
      "convert: footage converted, reused",
      "transcribe: transcribed, reused",
      "retime: retimed, reused",
      "remove_background: background removed, reused",
      "head_track: head tracked, reused",
      "preview_copies: preview copies made, reused",
      /^first_version: version 1 saved, /,
      // The AI double's scripted answer (fixtures/decide/short-speech.json).
      /^decide: decided: 1 accent, 1 transition, title set, 1 word fixed, /,
    ],
    { timeout: 10_000 },
  );
  // A hit: wall time only, the other measurements null.
  const { data: steps } = await admin
    .from("steps")
    .select(
      "name, status, cache_hit, wall_ms, cpu_ms, peak_rss_bytes, bytes_in, bytes_out, ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_model",
    )
    .eq("reel_id", reelId)
    .order("started_at");
  const noAi = { ai_input_tokens: null, ai_output_tokens: null, ai_cost_usd: null, ai_model: null };
  const hit = (name: string) => ({
    name,
    status: "skipped",
    cache_hit: true,
    wall_ms: expect.any(Number),
    cpu_ms: null,
    peak_rss_bytes: null,
    bytes_in: null,
    bytes_out: null,
    ...noAi,
  });
  expect(steps).toEqual([
    hit("convert"),
    hit("transcribe"),
    hit("retime"),
    hit("remove_background"),
    hit("head_track"),
    hit("preview_copies"),
    // In-process: wall time only.
    {
      name: "first_version",
      status: "done",
      cache_hit: false,
      wall_ms: expect.any(Number),
      cpu_ms: null,
      peak_rss_bytes: null,
      bytes_in: null,
      bytes_out: null,
      ...noAi,
    },
    // Never cached; the double spawns nothing, so no CPU or memory. The AI
    // columns hold the usage the script reports, as reported.
    {
      name: "decide",
      status: "done",
      cache_hit: false,
      wall_ms: expect.any(Number),
      cpu_ms: null,
      peak_rss_bytes: null,
      bytes_in: null,
      bytes_out: null,
      ai_input_tokens: 1200,
      ai_output_tokens: 340,
      ai_cost_usd: 0.0215,
      ai_model: "claude-fake",
    },
  ]);
  for (const step of steps!) expect(step.wall_ms).toBeGreaterThanOrEqual(0);

  // Version 1, from the preset alone, is still there; version 2, the AI's
  // edit of it, is the reel's current version.
  const { data: current } = await admin
    .from("reels")
    .select("current_version_id, preview_copies_fingerprint")
    .eq("id", reelId)
    .single();
  expect(current!.current_version_id).toEqual(expect.any(String));
  const { data: versions } = await admin
    .from("versions")
    .select(
      "id, number, model, request, parent_id, prompt_version, used_free_field, checks, inputs, r2_key",
    )
    .eq("reel_id", reelId)
    .order("number");
  expect(versions).toHaveLength(2);
  const [first, second] = versions!;
  const manifest = await readManifest();
  const fingerprint = (name: string) =>
    manifest.steps.find((step) => step.name === name)!.fingerprint;
  // Where the preview finds the reel's preview copies.
  expect(current!.preview_copies_fingerprint).toBe(fingerprint("preview_copies"));
  const inputs = {
    footage: fingerprint("retime"),
    transcript: fingerprint("retime"),
    cutout: fingerprint("remove_background"),
    headTrack: fingerprint("head_track"),
  };
  const keyOf = (id: string) => `${CACHE_PREFIX}reels/${reelId}/versions/${id}.json`;
  versionKeys.push(keyOf(first!.id), keyOf(second!.id));
  expect(first).toMatchObject({
    number: 1,
    model: null,
    request: null,
    parent_id: null,
    prompt_version: null,
    inputs,
    r2_key: keyOf(first!.id),
  });
  expect(second).toMatchObject({
    id: current!.current_version_id,
    number: 2,
    model: "claude-fake",
    request: null,
    parent_id: first!.id,
    prompt_version: "decide-1",
    used_free_field: false,
    checks: { ok: true },
    inputs,
    r2_key: keyOf(second!.id),
  });
  const transcript = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("retime/transcript.json", PIPELINE_FIXTURES), "utf8"),
  ) as Transcript;
  const parse = async (key: string) => {
    const stored = await storage.get(key);
    expect(stored, key).not.toBeNull();
    return parseEdit(new TextDecoder().decode(stored!), { transcript, preset: ISSEBYA });
  };
  // Version 1 unchanged: one caption per word as heard, nothing else.
  const v1 = await parse(first!.r2_key as string);
  expect(v1.tracks.captions).toHaveLength(transcript.words.length);
  expect(v1.tracks.overlays).toEqual([]);
  const v2 = await parse(second!.r2_key as string);
  expect(v2.tracks.overlays.map((overlay) => overlay.id)).toContain("title");
  await expect(page.getByTestId("current-version")).toHaveText("version 2", { timeout: 10_000 });
  await expect(page.getByTestId("reel-status")).toHaveText("processed", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
  expect(posthogRequests).toEqual([]);
});
