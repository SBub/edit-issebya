import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, fakeStorage } from "@edit-issebya/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { fingerprintsFor } from "./definition.ts";
import { parseProbe, probeArgs } from "./probe.ts";
import type { RetimePlan } from "./retime-plan.ts";
import { runPipeline } from "./run-pipeline.ts";
import { CLIP, REAL_TOOLS, realTool, videoStream } from "./tools-test-support.ts";
import { parseTranscript } from "./transcript.ts";

const SOURCE_KEY = `reels/${TEST_JOB.reel_id}/source/original.mp4`;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "retime-tools-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the whole pipeline with the real tools", () => {
  it("retimes the clip to H.264 30 fps matching its plan, keeping every word id", async () => {
    const storage = fakeStorage({ root: join(dir, "store"), uploadUrlBase: "" });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await storage.put(SOURCE_KEY, new Uint8Array(await readFile(CLIP)));
    const scratch = join(dir, "scratch");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await mkdir(scratch);
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await runPipeline({
      ctx: stepContext(steps),
      storage,
      keyPrefix: "",
      scratchDir: scratch,
      tools: REAL_TOOLS,
    });
    expect(calls.filter((call) => call.call === "done")).toHaveLength(6);

    const head = await storage.head(SOURCE_KEY);
    const fp = fingerprintsFor({ etag: head!.etag!, bytes: head!.bytes });
    const local = async (step: string, file: string) => {
      const path = join(dir, `${step}-${file}`);
      expect(await storage.getFile(cacheKey("", step, fp[step]!, file), path)).toBe(true);
      return path;
    };
    const source = await local("retime", "source.mp4");
    expect(await videoStream(source)).toMatchObject({ codec_name: "h264", r_frame_rate: "30/1" });
    const plan = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await readFile(await local("retime", "retime.json"), "utf8"),
    ) as RetimePlan;
    const probe = parseProbe(await realTool({ file: REAL_TOOLS.ffprobe, args: probeArgs(source) }));
    expect(Math.abs(probe.durationSeconds - plan.durationSeconds)).toBeLessThanOrEqual(1 / 30);

    const before = parseTranscript(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await readFile(await local("transcribe", "transcript.json"), "utf8"),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    const after = parseTranscript(await readFile(await local("retime", "transcript.json"), "utf8"));
    expect(after.words.map((word) => word.id)).toEqual(before.words.map((word) => word.id));
    expect(after.words.map((word) => word.text)).toEqual(before.words.map((word) => word.text));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect((await stat(source)).size).toBeGreaterThan(0);
  });
});
