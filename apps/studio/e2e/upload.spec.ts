import { stat } from "node:fs/promises";
import { ISSEBYA_PRESET, parseEdit, transcriptSchema } from "@edit-issebya/edit";
import { expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { pipelineManifest, seedPipelineCache } from "../test-support/pipeline-cache.ts";
import { eventsNamed, recordEvents } from "./events.ts";
import { SHORT_SPEECH_ANSWER } from "../test-support/ai-script.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { jobsOf, reelStatus, stepLines } from "../test-support/rows.ts";
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
const exportKeys: string[] = [];
// The pipeline outputs tagged rebuildable (apps/worker's step definitions);
// every other output is kept.
const REBUILDABLE = new Set([
  "convert/converted.mp4",
  "retime/source.mp4",
  "backgrounds/backgrounds.json",
]);

interface StoredFileRecord {
  r2_key: string;
  bytes: number;
  kind: string;
  step: string;
  deleted_at: string | null;
}

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
  for (const key of exportKeys) await storage.delete(key);
  if (owner) await deleteTestUser(admin, owner.id);
});

test("an uploaded clip goes through every pipeline step, gets version 1 and the AI's version 2, and the page updates live", async ({
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
  await page.getByRole("button", { name: "Upload a reel" }).click();
  await page.getByLabel("Clip").setInputFiles(CLIP);
  // The drop zone shows the chosen clip's name.
  await expect(page.getByTestId("upload-chosen")).toHaveText("short-speech.mp4");
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  // One click creates the multipart upload, signs and PUTs its one part to
  // the storage double, completes it and navigates to the reel page. Under
  // `next dev` each route compiles on first hit, which can outlast the 5s
  // default on a fresh server.
  await expect(page).toHaveURL(
    /\/studio\/reels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    { timeout: 20_000 },
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
  // The AI double answers with the committed script: one accent, one fixed
  // word and the written hook.
  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
  });
  expect(worker.code, worker.output).toBe(0);

  expect((await jobsOf(admin, reelId)).map((job) => job.status)).toEqual(["done"]);
  // The footage check runs first (ffprobe on the downloaded source); every
  // fixed step's outputs were already stored: each is a hit, nothing ran.
  const lines = (await stepLines(admin, reelId)).map((line) => `${line.name}: ${line.summary}`);
  expect(lines).toEqual([
    expect.stringMatching(/^check_footage: footage checked, /),
    "convert: footage converted, reused",
    "transcribe: transcribed, reused",
    "retime: retimed, reused",
    "head_track: head tracked, reused",
    "preview_copies: preview copies made, reused",
    // The footage's background map, sampled once by ffmpeg before version 1
    // (the engine keeps the captions readable over it), then reused by decide.
    expect.stringMatching(/^backgrounds: backgrounds of 5 frames, /),
    expect.stringMatching(/^first_version: version 1 saved, /),
    // On the 2.7 s clip the written hook holds the screen from 0.2 s to the
    // end, and the accent shows over it: `all` placement drops nothing the
    // answer picks.
    expect.stringMatching(/^decide: version 2: 1 accent, 0 transitions, hook set, 1 word fixed, /),
    "backgrounds: backgrounds reused",
  ]);
  // A hit: wall time only, the other measurements null.
  const { data: steps } = await admin
    .from("steps")
    .select("name, status, cache_hit, wall_ms, cpu_ms, peak_rss_bytes, bytes_in, bytes_out")
    .eq("reel_id", reelId)
    .order("started_at");
  const hit = (name: string) => ({
    name,
    status: "skipped",
    cache_hit: true,
    wall_ms: expect.any(Number),
    cpu_ms: null,
    peak_rss_bytes: null,
    bytes_in: null,
    bytes_out: null,
  });
  expect(steps).toEqual([
    // A tool step: ffprobe ran, so its measurements are the runner's.
    expect.objectContaining({ name: "check_footage", status: "done", cache_hit: false }),
    hit("convert"),
    hit("transcribe"),
    hit("retime"),
    hit("head_track"),
    hit("preview_copies"),
    // A tool step: ffmpeg ran.
    expect.objectContaining({ name: "backgrounds", status: "done", cache_hit: false }),
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
    },
    // Through the step runner, but the double spawns nothing: no CPU or memory.
    {
      name: "decide",
      status: "done",
      cache_hit: false,
      wall_ms: expect.any(Number),
      cpu_ms: null,
      peak_rss_bytes: null,
      bytes_in: null,
      bytes_out: null,
    },
    // Inside decide: the map made before version 1.
    hit("backgrounds"),
  ]);
  for (const step of steps!) expect(step.wall_ms).toBeGreaterThanOrEqual(0);
  // No background removal: no step row names it.
  expect(steps!.map((step) => step.name)).not.toContain("remove_background");
  // The usage the scripted reply reports, exactly, once per call: the input
  // tokens, the output tokens, the cost and the model.
  const { data: decideRow } = await admin
    .from("steps")
    .select("ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_model")
    .eq("reel_id", reelId)
    .eq("name", "decide")
    .single();
  expect(decideRow).toMatchObject({
    // The hook call (300 in, 40 out, 0.0015) and the decide call (1500 in,
    // 456 out, 0.0123); the model stays the editor's.
    ai_input_tokens: 1800,
    ai_output_tokens: 496,
    ai_model: "anthropic/claude-haiku-5.5",
  });
  // A float sum of the two calls' costs: compared to nine decimals.
  expect(decideRow!.ai_cost_usd).toBeCloseTo(0.0138, 9);

  // Version 1: built from the preset alone; version 2: the AI's, its parent
  // version 1, now current. Both edits are in storage.
  const { data: withVersion } = await admin
    .from("reels")
    .select("current_version_id, preview_copies")
    .eq("id", reelId)
    .single();
  const currentId = withVersion!.current_version_id as string | null;
  expect(currentId).not.toBeNull();
  // The preview copies recorded on the reel: the footage copy, the grid's
  // thumbnail and the timeline's frames sprite with its layout.
  const previewFingerprint = (await pipelineManifest()).steps.find(
    (step) => step.name === "preview_copies",
  )!.fingerprint;
  const previewRef = (file: string) => ({
    step: "preview_copies",
    fingerprint: previewFingerprint,
    file,
  });
  expect(withVersion!.preview_copies).toEqual({
    footage: previewRef("footage-preview.mp4"),
    thumbnail: previewRef("thumbnail.jpg"),
    frames: previewRef("frames.jpg"),
    frames_layout: { everySeconds: 2, columns: 32, width: 90, height: 160 },
  });
  const { data: versions } = await admin
    .from("versions")
    .select(
      "id, number, model, request, parent_id, prompt_version, change_title, change_summary, checks, used_free_field, unexpressed, free_field, rejected_reasons, r2_key",
    )
    .eq("reel_id", reelId)
    .order("number");
  expect(versions).toHaveLength(2);
  const [v1, v2] = versions!;
  const key = (id: unknown) => `${CACHE_PREFIX}reels/${reelId}/versions/${String(id)}.json`;
  expect(v1).toEqual({
    id: v1!.id,
    number: 1,
    model: null,
    request: null,
    parent_id: null,
    prompt_version: null,
    change_title: null,
    change_summary: "automatic first version from the issebya style",
    checks: [],
    used_free_field: false,
    unexpressed: [],
    free_field: [],
    rejected_reasons: [],
    r2_key: key(v1!.id),
  });
  // A new version saves no title and no summary: the change box is gone.
  expect(v2).toEqual({
    id: currentId,
    number: 2,
    model: "anthropic/claude-haiku-5.5",
    request: null,
    parent_id: v1!.id,
    prompt_version: "reel-components@v1",
    change_title: null,
    change_summary: null,
    checks: [],
    used_free_field: false,
    unexpressed: [],
    free_field: [],
    rejected_reasons: [],
    r2_key: key(currentId),
  });
  versionKeys.push(v1!.r2_key as string, v2!.r2_key as string);
  // Version 2's AI record beside its edit: the hook call and the decide call,
  // each with its prompt and raw answer.
  const aiRecordKey = `${CACHE_PREFIX}reels/${reelId}/versions/${String(currentId)}.ai.json`;
  const aiRecord = JSON.parse(new TextDecoder().decode((await storage.get(aiRecordKey))!)) as {
    version_id: string;
    hook_prompt_version: string;
    calls: { role: string; prompt: string; promptVersion: string; answerText: string | null }[];
  };
  expect(aiRecord.version_id).toBe(currentId);
  expect(aiRecord.hook_prompt_version).toBe("reel-hook@v1");
  expect(aiRecord.calls.map((call) => call.role)).toEqual(["hook", "decide"]);
  expect(aiRecord.calls[0]!.answerText).toContain("A short test for the real studio");
  expect(aiRecord.calls[1]!.prompt).toContain("w0010");
  expect(aiRecord.calls.map((call) => call.promptVersion)).toEqual([
    "reel-hook@v1",
    "reel-components@v1",
  ]);
  const manifest = await pipelineManifest();
  const retime = manifest.steps.find((step) => step.name === "retime")!;
  const transcript = transcriptSchema.parse(
    JSON.parse(
      new TextDecoder().decode(
        (await storage.get(`${CACHE_PREFIX}cache/retime/${retime.fingerprint}/transcript.json`))!,
      ),
    ),
  );
  for (const versionKey of versionKeys) {
    const stored = await storage.get(versionKey);
    expect(stored).not.toBeNull();
    const parsed = parseEdit(
      JSON.parse(new TextDecoder().decode(stored!)),
      ISSEBYA_PRESET,
      transcript,
    );
    expect(parsed.ok, parsed.ok ? "" : parsed.reasons.join("; ")).toBe(true);
    if (versionKey === v2!.r2_key && parsed.ok) {
      // The written hook (its own text, no words), then the accent over it
      // (its one word, w0005, shown from the lead before it).
      expect(parsed.edit.tracks.overlays).toEqual([
        expect.objectContaining({
          id: "hook",
          kind: "hook",
          text: "A short test for the real studio",
        }),
        expect.objectContaining({
          id: "accent-1",
          kind: "accent",
          words: ["w0005"],
        }),
      ]);
      expect(parsed.edit.tracks.transitions).toEqual([]);
    }
  }
  expect(await reelStatus(admin, reelId)).toBe("processed");
  // The page followed it live: the new version notice or nothing, never a failure.
  await expect(page.locator('[data-overlay-kind="failure"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
  expect(posthogRequests).toEqual([]);

  // An export of the current version, so every kind of stored file exists.
  const render = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, kind: "render", version_id: currentId });
  expect(render.error).toBeNull();
  const exporter = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
  });
  expect(exporter.code, exporter.output).toBe(0);
  const { data: exportRows } = await admin.from("exports").select("r2_key").eq("reel_id", reelId);
  expect(exportRows).toHaveLength(1);
  const exportKey = exportRows![0]!.r2_key as string;
  exportKeys.push(exportKey);

  // Every object in this run's storage, and the source, has exactly one
  // stored_files row of this reel with its size, kind and step.
  const { data: storedRows, error: storedError } = await admin
    .from("stored_files")
    .select("r2_key, bytes, kind, step, deleted_at")
    .eq("reel_id", reelId);
  expect(storedError).toBeNull();
  const live = (storedRows as StoredFileRecord[]).filter((row) => row.deleted_at === null);
  const expectedOf = (objectKey: string) => {
    if (objectKey === sourceKey!) return { kind: "source", step: "upload" };
    if (objectKey === exportKey) return { kind: "export", step: "render" };
    if (versionKeys.includes(objectKey)) return { kind: "version", step: "version" };
    if (objectKey === aiRecordKey) return { kind: "version", step: "decide" };
    const [, step, , file] = objectKey.slice(CACHE_PREFIX.length).split("/");
    return { kind: REBUILDABLE.has(`${step}/${file}`) ? "rebuildable" : "kept", step: step! };
  };
  const objectKeys = [...(await storage.list(CACHE_PREFIX)), sourceKey!];
  expect(objectKeys).toContain(exportKey);
  // No cut-out and no cut-out preview copy is stored.
  for (const objectKey of objectKeys) {
    expect(objectKey).not.toMatch(/remove_background|subject-preview/);
  }
  for (const versionKey of versionKeys) expect(objectKeys).toContain(versionKey);
  // The preview_copies step's three kept outputs are stored and tracked.
  for (const file of ["footage-preview.mp4", "thumbnail.jpg", "frames.jpg"]) {
    const previewKey = objectKeys.find((objectKey) =>
      objectKey.endsWith(`/cache/preview_copies/${previewFingerprint}/${file}`),
    );
    expect(previewKey, file).toBeDefined();
    expect(live.filter((row) => row.r2_key === previewKey)).toEqual([
      expect.objectContaining({ kind: "kept", step: "preview_copies" }),
    ]);
  }
  // The background map: one object for the footage, rebuildable.
  const backgroundKeys = objectKeys.filter((objectKey) =>
    /\/cache\/backgrounds\/[0-9a-f]{64}\/backgrounds\.json$/.test(objectKey),
  );
  expect(backgroundKeys).toHaveLength(1);
  seededKeys.push(...backgroundKeys);
  expect(live.filter((row) => row.r2_key === backgroundKeys[0])).toEqual([
    expect.objectContaining({ kind: "rebuildable", step: "backgrounds" }),
  ]);
  for (const objectKey of objectKeys) {
    const rows = live.filter((row) => row.r2_key === objectKey);
    expect(rows, objectKey).toHaveLength(1);
    expect(rows[0], objectKey).toMatchObject({
      bytes: (await storage.head(objectKey))!.bytes,
      ...expectedOf(objectKey),
    });
  }
  // And no live row names an object that is not there.
  expect(live.map((row) => row.r2_key).sort()).toEqual([...objectKeys].sort());
});
