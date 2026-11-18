import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStorage } from "@edit-issebya/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { PIPELINE, fingerprintsFor } from "./definition.ts";
import { cacheKey } from "./fingerprint.ts";
import { parseProbe, probeArgs } from "./probe.ts";
import { retimeFilterGraph } from "./retime-encode.ts";
import type { RetimePlan } from "./retime-plan.ts";
import { RETIME_PRESET, type RetimeSettings } from "./retime-preset.ts";
import { runPipeline } from "./run-pipeline.ts";
import { CLIP, REAL_TOOLS, ffmpeg, realTool, videoStream } from "./tools-test-support.ts";
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
    expect(calls.filter((call) => call.call === "done")).toHaveLength(PIPELINE.length);

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

// The joins of the retimed sound, with the real ffmpeg on the committed
// converted clip (83 frames, mono at 22.05 kHz: 735 samples a frame): a cut,
// a change of speed, a slowed frame. The same plan is run with the join fades
// and without them, the sound taken as raw samples (no AAC in between).
describe("the retimed sound at its joins", () => {
  const CONVERTED = new URL("../../../../fixtures/pipeline/convert/converted.mp4", import.meta.url)
    .pathname;
  const RATE = 22_050;
  const FPS = RETIME_PRESET.frameRate;
  // Frames 20 to 30 are cut; frame 50 plays at 0.6x.
  const PIECES: [number, number, number][] = [
    [0, 20, 1.05],
    [30, 50, 1.1],
    [50, 51, 0.6],
    [51, 83, 1.05],
  ];
  let at = 0;
  const PLAN: RetimePlan = {
    segments: PIECES.map(([first, end, speed]) => {
      const start = at;
      at += (end - first) / FPS / speed;
      return { orig: [first / FPS, end / FPS], speed, new: [start, at] };
    }),
    durationSeconds: at,
  };
  // Each piece's samples: its frames at its speed, as the graph trims it.
  const LENGTHS = PIECES.map(([first, end, speed]) =>
    Math.round(((end - first) * (RATE / FPS)) / speed),
  );
  const JOINS = LENGTHS.slice(0, -1).map((_, index) =>
    LENGTHS.slice(0, index + 1).reduce((sum, length) => sum + length, 0),
  );

  async function retimed(name: string, settings: RetimeSettings) {
    const graph = join(dir, `${name}.graph.txt`);
    const sound = join(dir, `${name}.f32`);
    const frames = join(dir, `${name}.framemd5`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(graph, retimeFilterGraph(PLAN, RATE, settings));
    await ffmpeg([
      "-i",
      CONVERTED,
      "-/filter_complex",
      graph,
      "-map",
      "[a]",
      "-f",
      "f32le",
      sound,
      "-map",
      "[v]",
      "-f",
      "framemd5",
      frames,
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    const bytes = new Uint8Array(await readFile(sound)).slice();
    return {
      samples: new Float32Array(bytes.buffer),
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      frames: await readFile(frames, "utf8"),
    };
  }

  it("fades out and in at every join, with the same length and the same picture", async () => {
    const fade = Math.round(RETIME_PRESET.joinFadeSeconds * RATE);
    expect(fade).toBe(110);
    const faded = await retimed("faded", RETIME_PRESET);
    const hard = await retimed("hard", { ...RETIME_PRESET, joinFadeSeconds: 0 });

    // The length is the plan's, to the sample, with the fades and without.
    const total = LENGTHS.reduce((sum, length) => sum + length, 0);
    expect(faded.samples).toHaveLength(total);
    expect(hard.samples).toHaveLength(total);
    expect(Math.abs(total / RATE - PLAN.durationSeconds)).toBeLessThan(2 / RATE);
    // The picture is the same frames, byte for byte.
    expect(faded.frames).toBe(hard.frames);
    const pictures = faded.frames.split("\n").filter((line) => /^\d/.test(line)).length;
    expect(Math.abs(pictures - PLAN.durationSeconds * FPS)).toBeLessThanOrEqual(1);

    const peak = (samples: Float32Array, from: number, to: number) =>
      samples.slice(from, to).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    for (const joinAt of JOINS) {
      // The hard join has sound right at it (the clip is speech and room
      // sound throughout); the faded one is silent there and rises away from it.
      expect(peak(hard.samples, joinAt - 4, joinAt + 4)).toBeGreaterThan(0);
      expect(peak(faded.samples, joinAt - 2, joinAt + 2)).toBeLessThanOrEqual(
        peak(hard.samples, joinAt - 2, joinAt + 2) * 0.05,
      );
      expect(Math.abs(faded.samples[joinAt]!)).toBe(0);
      // No sample is louder for the fade.
      for (let index = joinAt - fade; index < joinAt + fade; index += 1) {
        expect(Math.abs(faded.samples[index]!)).toBeLessThanOrEqual(
          Math.abs(hard.samples[index]!) + 1e-7,
        );
      }
    }
    // Away from the joins nothing changed: the same samples.
    const nearJoin = (index: number) => JOINS.some((joinAt) => Math.abs(index - joinAt) <= fade);
    let changed = 0;
    for (let index = 0; index < total; index += 1) {
      if (!nearJoin(index) && faded.samples[index] !== hard.samples[index]) changed += 1;
    }
    expect(changed).toBe(0);
  });
});
