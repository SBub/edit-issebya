import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AiRequest, type AiRunner, fakeAiRunner } from "../ai.ts";
import { AiUnavailable, PermanentError, findCause } from "../failure.ts";
import type { ClaimedJob } from "../queue.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { type ChildRun, type SpawnTool, StepError } from "../step-runner.ts";
import { runDescribePhotoJob } from "./describe-photo.ts";
import type { PhotoStore, ReadyPhoto } from "./photo-store.ts";

const PREFIX = "dev/";
const PHOTO = "7a2d0c1e-4b5f-4c3a-9e8d-1f2a3b4c5d6e";
const ORIGINAL = `${PREFIX}library/${PHOTO}/original.jpg`;
const TOOLS = { ffmpeg: "/bin/ffmpeg", ffprobe: "/bin/ffprobe" };
const PHOTO_JOB: ClaimedJob = {
  ...TEST_JOB,
  kind: "describe_photo",
  reel_id: null,
  photo_id: PHOTO,
};
const TESTDATA = new URL("./testdata/", import.meta.url);

type Json = Record<string, unknown>;

let root: string;
let scratch: string;
let storage: Storage;
let readyWrites: { photoId: string; photo: ReadyPhoto }[];
let answer: Json;
let refused: Json;

async function envelope(name: string): Promise<Json> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed script
  return JSON.parse(await readFile(new URL(name, TESTDATA), "utf8")) as Json;
}

const ok = (stdout = ""): ChildRun => ({
  code: 0,
  exitSignal: null,
  report: "",
  output: stdout,
  stdout,
  groupPeakBytes: null,
});

// ffprobe answers a 4032x3024 photo; ffmpeg writes the file it is asked for.
const fakeTools: SpawnTool = async (call) => {
  if (call.file === TOOLS.ffprobe) {
    return ok(
      JSON.stringify({ streams: [{ index: 0, codec_type: "video", width: 4032, height: 3024 }] }),
    );
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await writeFile(call.args.at(-1)!, `jpeg for ${call.args[call.args.indexOf("-vf") + 1]}`);
  return ok();
};

function memoryStore({ gone = false, deletedMeanwhile = false } = {}): PhotoStore {
  return {
    async read() {
      return gone ? null : { r2_key: ORIGINAL, content_type: "image/jpeg", status: "describing" };
    },
    async ready(photoId, photo) {
      if (deletedMeanwhile) throw new Error(`photo ${photoId} is gone or not describing`);
      readyWrites.push({ photoId, photo });
    },
  };
}

// The double, also noting what the folder Claude Code runs in holds.
function seeingAi(script: unknown[]): AiRunner & { calls: AiRequest[]; folders: string[][] } {
  const inner = fakeAiRunner(script);
  const folders: string[][] = [];
  return {
    calls: inner.calls,
    folders,
    async call(tool, request) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      folders.push(await readdir(request.cwd));
      return inner.call(tool, request);
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "describe-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "describe-scratch-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  await storage.put(ORIGINAL, new Uint8Array([0xff, 0xd8, 0xff]));
  readyWrites = [];
  answer = await envelope("describe-answer.json");
  refused = await envelope("describe-refused.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

function run(ai: AiRunner, store: PhotoStore = memoryStore()) {
  const { steps, calls } = recordingSteps();
  const job = runDescribePhotoJob({
    ctx: stepContext(steps, { job: PHOTO_JOB }),
    storage,
    store,
    ai,
    tools: TOOLS,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    photoId: PHOTO,
    spawnTool: fakeTools,
  });
  return { job, calls };
}

describe("runDescribePhotoJob", () => {
  it("makes both copies, reads only photo.jpg and writes the photo ready", async () => {
    const ai = seeingAi([answer]);
    const { job, calls } = run(ai);
    await job;
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({ readFile: "photo.jpg", cwd: join(scratch, "describe") });
    expect(ai.folders).toEqual([["photo.jpg"]]);
    expect(readyWrites).toEqual([
      {
        photoId: PHOTO,
        photo: {
          description: "A colourful test pattern with bars and a moving circle.",
          tags: ["test pattern", "colour bars", "abstract"],
          model: "claude-opus-5-5",
          promptVersion: "describe-photo-1",
          width: 4032,
          height: 3024,
          thumbnailKey: `${PREFIX}library/${PHOTO}/thumbnail.jpg`,
          largeKey: `${PREFIX}library/${PHOTO}/large.jpg`,
        },
      },
    ]);
    const thumbnail = await storage.get(`${PREFIX}library/${PHOTO}/thumbnail.jpg`);
    expect(new TextDecoder().decode(thumbnail!)).toBe("jpeg for scale=480:360");
    const large = await storage.get(`${PREFIX}library/${PHOTO}/large.jpg`);
    expect(new TextDecoder().decode(large!)).toBe("jpeg for scale=1568:1176");

    const done = calls.filter((call) => call.call === "done");
    expect(done.map((call) => call.summary.split(", under")[0])).toEqual([
      "4032x3024, thumbnail 480x360",
      "3 tags: test pattern, colour bars, abstract",
    ]);
    expect(done[1]!.measurements).toMatchObject({
      ai_input_tokens: 1200,
      ai_output_tokens: 80,
      ai_cost_usd: 0.004,
      ai_model: "claude-opus-5-5",
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(await readdir(scratch)).toEqual(["photo"]);
  });

  it("sends a refused answer back once with its reasons, then writes ready", async () => {
    const ai = seeingAi([refused, answer]);
    const { job } = run(ai);
    await job;
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.prompt).toMatch(/Your previous answer was refused/);
    expect(ai.calls[1]!.prompt).toMatch(/- tags: /);
    expect(readyWrites).toHaveLength(1);
  });

  it("fails after a second refusal with both rounds, the usage spent and no ready write", async () => {
    const ai = seeingAi([refused, refused]);
    const { job, calls } = run(ai);
    const error = findCause(await job.catch((thrown: unknown) => thrown), StepError);
    expect(error).toBeInstanceOf(StepError);
    expect(error!.tail).toMatch(
      /^describe_photo: the answer failed twice\nround 1:\n- tags: .*\nround 2:\n- tags: /,
    );
    expect(ai.calls).toHaveLength(2);
    expect(readyWrites).toEqual([]);
    const failed = calls.find((call) => call.call === "failed");
    if (failed?.call !== "failed") throw new Error(JSON.stringify(calls));
    expect(failed.measurements).toMatchObject({ ai_input_tokens: 2400, ai_cost_usd: 0.008 });
  });

  it("waits when Claude Code is unavailable, writing nothing", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
    const limit = await readFile(
      new URL("../decide/testdata/claude-usage-limit.json", import.meta.url),
      "utf8",
    );
    const ai = seeingAi([limit]);
    const { job, calls } = run(ai);
    const error = await job.catch((thrown: unknown) => thrown);
    expect(findCause(error, AiUnavailable)?.reason).toBe("the usage limit is reached");
    expect(ai.calls).toHaveLength(1);
    expect(readyWrites).toEqual([]);
    expect(calls.some((call) => call.call === "waiting")).toBe(true);
  });

  it("fails for good when the photo is gone before or deleted during the job", async () => {
    const before = run(seeingAi([answer]), memoryStore({ gone: true }));
    await expect(before.job).rejects.toThrow(PermanentError);
    expect(before.calls).toEqual([]);

    const meanwhile = run(seeingAi([answer]), memoryStore({ deletedMeanwhile: true }));
    await expect(meanwhile.job).rejects.toThrow(PermanentError);
    expect(readyWrites).toEqual([]);
  });
});
