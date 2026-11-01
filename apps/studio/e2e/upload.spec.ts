import { readFile, stat } from "node:fs/promises";
import { ISSEBYA_PRESET, parseEdit, transcriptSchema } from "@edit-issebya/edit";
import { expect, test } from "@playwright/test";
import { e2eStorageRoot, fakeStorage } from "@edit-issebya/storage";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { pipelineManifest, seedPipelineCache } from "../test-support/pipeline-cache.ts";
import { eventsNamed, recordEvents } from "./events.ts";
import { SHORT_SPEECH_ANSWER } from "../test-support/ai-script.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
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
  await page.getByLabel("Clip").setInputFiles(CLIP);
  await page.getByRole("button", { name: "Upload" }).click();

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
  // The AI double answers with the committed script: a title, one accent,
  // one transition and one fixed word.
  const worker = await runWorkerOnce({
    R2_KEY_PREFIX: CACHE_PREFIX,
    E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
  });
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
      /^decide: version 2: 1 accent, 1 transition, title set, 1 word fixed, /,
    ],
    { timeout: 10_000 },
  );
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
  ]);
  for (const step of steps!) expect(step.wall_ms).toBeGreaterThanOrEqual(0);
  // The usage the scripted result reports, exactly: every input token
  // (1200 + 300 + 0), the output tokens, the cost and the model.
  const { data: decideRow } = await admin
    .from("steps")
    .select("ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_model")
    .eq("reel_id", reelId)
    .eq("name", "decide")
    .single();
  expect(decideRow).toEqual({
    ai_input_tokens: 1500,
    ai_output_tokens: 456,
    ai_cost_usd: 0.0123,
    ai_model: "claude-opus-5-5",
  });

  // Version 1: built from the preset alone; version 2: the AI's, its parent
  // version 1, now current. Both edits are in storage.
  const { data: withVersion } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reelId)
    .single();
  const currentId = withVersion!.current_version_id as string | null;
  expect(currentId).not.toBeNull();
  const { data: versions } = await admin
    .from("versions")
    .select(
      "id, number, model, request, parent_id, prompt_version, change_summary, checks, used_free_field, unexpressed, free_field, rejected_reasons, r2_key",
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
    change_summary: "automatic first version from the issebya style",
    checks: [],
    used_free_field: false,
    unexpressed: [],
    free_field: [],
    rejected_reasons: [],
    r2_key: key(v1!.id),
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed script
  const script = JSON.parse(await readFile(SHORT_SPEECH_ANSWER, "utf8")) as {
    structured_output: { change_summary: string };
  };
  expect(v2).toEqual({
    id: currentId,
    number: 2,
    model: "claude-opus-5-5",
    request: null,
    parent_id: v1!.id,
    prompt_version: "decide-1",
    change_summary: script.structured_output.change_summary,
    checks: [],
    used_free_field: false,
    unexpressed: [],
    free_field: [],
    rejected_reasons: [],
    r2_key: key(currentId),
  });
  versionKeys.push(v1!.r2_key as string, v2!.r2_key as string);
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
      expect(parsed.edit.tracks.overlays.map((item) => item.id)).toContain("title");
    }
  }
  await expect(page.getByTestId("reel-status")).toHaveText("processed", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "marker",
  );
  expect(posthogRequests).toEqual([]);
});
