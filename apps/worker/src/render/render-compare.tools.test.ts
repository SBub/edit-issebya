import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Edit, ISSEBYA_PRESET, build, reelFrames } from "@edit-issebya/edit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spanCropTop } from "../cutout/crop.ts";
import { maskToolCall } from "../cutout/mask-tool.ts";
import { withMasks } from "../cutout/spans.ts";
import { editMeasurer } from "../edit-measurer.ts";
import { REAL_TOOLS } from "../pipeline/tools-test-support.ts";
import { recordingSteps, stepContext } from "../recording-steps.ts";
import { runToolsStep, spawnChild } from "../step-runner.ts";
import { assertSoundCovers, soundCutArgs, soundPackets, soundPacketsArgs } from "./composite.ts";
import {
  layerArgs,
  renderEnv,
  renderScratchEnv,
  soundPageFps,
  withChromeTmp,
} from "./render-call.ts";
import { type RenderFiles, writeRenderProject } from "./render-project.ts";
import type { RenderRoute, RenderSettings } from "./render-route.ts";
import { renderVersion } from "./render-step.ts";
import { type FixtureReel, fixtureEdit, fixturePath } from "./render-test-support.ts";

// The machine check of "the composite export looks and sounds the same": each
// fixture reel is exported both ways with the real tools, the single call and
// the composite in `match` mode, and the two MP4s are compared: the same frame
// count and length, every frame at or above the export guardrail's SSIM bound,
// and the same decoded sound, sample for sample. On the owner's Mac only
// (HyperFrames, Chrome and ffmpeg), never in CI.
//
// The bound is the preview-matches-export guardrail's (app_docs/export.md,
// PREVIEW_EXPORT_SSIM_BOUND in apps/studio/e2e-tools): a composite frame may be
// no further from the single call's frame than the preview may be from the
// export.
const SSIM_BOUND = 0.9855;
const run = promisify(execFile);

let dir: string;

interface Exported {
  output: string;
  route: RenderRoute;
  // Every progress percent the step wrote, in order.
  progress: number[];
  cpuMs: number | null;
  peakRssBytes: number | null;
  wallMs: number;
}

async function exportReel(
  name: string,
  reel: FixtureReel,
  edit: Edit,
  files: RenderFiles,
  settings: RenderSettings,
): Promise<Exported> {
  const { transcript, headTrack } = await fixtureEdit(reel);
  const renderDir = join(dir, name);
  const { steps, calls } = recordingSteps();
  let rendered: { output: string; route: RenderRoute } | null = null;
  await runToolsStep(
    stepContext(steps),
    {
      name: "render",
      outputs: [join(renderDir, "export.mp4")],
      async work(tool) {
        rendered = await renderVersion({
          tool,
          tools: REAL_TOOLS,
          dir: renderDir,
          edit,
          transcript,
          headTrack,
          files,
          settings,
        });
        return { what: "exported" };
      },
    },
    spawnChild,
  );
  const done = calls.find((call) => call.call === "done");
  if (!rendered || done?.call !== "done") throw new Error(`${name}: the render did not finish`);
  const { output, route } = rendered as { output: string; route: RenderRoute };
  return {
    output,
    route,
    progress: calls.flatMap((call) => (call.call === "progress" ? [call.percent] : [])),
    cpuMs: done.measurements.cpu_ms,
    peakRssBytes: done.measurements.peak_rss_bytes,
    wallMs: done.measurements.wall_ms,
  };
}

// SSIM of every frame of `candidate` against `reference`, in frame order.
async function frameSsim(candidate: string, reference: string, name: string): Promise<number[]> {
  const stats = join(dir, `${name}.ssim.txt`);
  await run(
    REAL_TOOLS.ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      candidate,
      "-i",
      reference,
      "-lavfi",
      `[0:v][1:v]ssim=stats_file=${stats}`,
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  const text = await readFile(stats, "utf8");
  return [...text.matchAll(/All:([0-9.]+)/g)].map((match) => Number(match[1]));
}

async function probe(path: string, entries: string, stream?: string): Promise<string> {
  const { stdout } = await run(REAL_TOOLS.ffprobe, [
    "-v",
    "error",
    ...(stream ? ["-select_streams", stream] : []),
    "-count_frames",
    "-show_entries",
    entries,
    "-of",
    "csv=p=0",
    path,
  ]);
  return stdout.trim().replace(/,+$/, "");
}

// SHA-256 of what ffmpeg writes to stdout.
function hashOf(args: string[]): Promise<{ hash: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      REAL_TOOLS.ffmpeg,
      ["-v", "error", "-nostdin", ...args],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) =>
        error
          ? reject(error)
          : resolve({
              hash: createHash("sha256").update(stdout).digest("hex"),
              bytes: stdout.byteLength,
            }),
    );
  });
}

// The decoded sound: every sample of the first audio stream, 16-bit.
const decodedSound = (path: string) => hashOf(["-i", path, "-map", "0:a:0", "-f", "s16le", "-"]);
// The stored sound: the AAC packets as they are in the file.
const storedSound = (path: string) =>
  hashOf(["-i", path, "-map", "0:a:0", "-c", "copy", "-f", "adts", "-"]);

interface Compared {
  frames: number;
  mean: number;
  min: number;
  under: number;
}

// The whole machine check of one pair of exports.
async function expectSameExport(name: string, composite: Exported, single: Exported, edit: Edit) {
  expect(single.route).toMatchObject({ path: "single" });
  expect(composite.route).toEqual({ path: "composite", mode: "match" });

  // The same frame count (the reel's) and the same length, picture and sound.
  const frames = reelFrames(edit.duration);
  for (const exported of [single, composite]) {
    expect(await probe(exported.output, "stream=codec_name,width,height,r_frame_rate", "v:0")).toBe(
      "h264,1080,1920,30/1",
    );
    expect(Number(await probe(exported.output, "stream=nb_read_frames", "v:0"))).toBe(frames);
  }
  for (const entries of ["format=duration", "stream=duration,nb_frames"]) {
    expect(await probe(composite.output, entries)).toBe(await probe(single.output, entries));
  }

  // Every frame at or above the bound.
  const scores = await frameSsim(composite.output, single.output, name);
  const compared: Compared = {
    frames: scores.length,
    mean: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    min: Math.min(...scores),
    under: scores.filter((score) => score < SSIM_BOUND).length,
  };
  console.log(
    `${name}: ${compared.frames} frames, SSIM mean ${compared.mean.toFixed(5)}, min ${compared.min.toFixed(5)} ` +
      `(frame ${scores.indexOf(compared.min)}), ${compared.under} under ${SSIM_BOUND}; ` +
      `single ${single.wallMs} ms wall, ${single.cpuMs} ms CPU; composite ${composite.wallMs} ms wall, ${composite.cpuMs} ms CPU`,
  );
  expect(compared.frames).toBe(frames);
  expect(
    scores.map((score, frame) => ({ frame, score })).filter(({ score }) => score < SSIM_BOUND),
  ).toEqual([]);

  // The same sound: identical decoded samples, and the same AAC packets.
  const [heard, reference] = [
    await decodedSound(composite.output),
    await decodedSound(single.output),
  ];
  expect(heard.bytes).toBeGreaterThan(0);
  expect(heard).toEqual(reference);
  expect(await storedSound(composite.output)).toEqual(await storedSound(single.output));
  return compared;
}

const SINGLE: RenderSettings = { path: "single", mode: "match" };
const MATCH: RenderSettings = { path: "composite", mode: "match" };
const CLEAN: RenderSettings = { path: "composite", mode: "clean" };

// Chrome's short temporary folders (withChromeTmp: `hf-` and six characters)
// in the system temp folder.
async function chromeFolders(): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the system temp folder
  return (await readdir(tmpdir())).filter((entry) => /^hf-[A-Za-z0-9]{6}$/.test(entry));
}
let chromeFoldersBefore: Set<string>;

beforeAll(async () => {
  chromeFoldersBefore = new Set(await chromeFolders());
  dir = await mkdtemp(join(tmpdir(), "render-compare-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the composite export against the single call", () => {
  // The short fixture reel with two clicks: captions over the footage and the
  // sound track mixed in. Its footage has 79 frames for 81 output frames, so
  // the last frames are ones the footage clip holds.
  describe("a reel with captions and clicks", () => {
    const FILES = { footage: fixturePath("retime", "source.mp4") };
    let edit: Edit;
    let single: Exported;
    let composite: Exported;

    beforeAll(async () => {
      edit = structuredClone((await fixtureEdit()).edit);
      edit.tracks.sounds = ["w0005", "w0009"].map((word, index) => ({
        id: `click-${index + 1}`,
        sound: "click" as const,
        start: { word, edge: "start" as const },
        end: { word, edge: "start" as const, offset: 0.23 },
      }));
      single = await exportReel("clicks-single", "short-speech", edit, FILES, SINGLE);
      composite = await exportReel("clicks-composite", "short-speech", edit, FILES, MATCH);
    });

    it("matches on every frame and in every sample", async () => {
      await expectSameExport("clicks", composite, single, edit);
    });

    it("reports rising progress from its processes and ends at 100", () => {
      expect(composite.progress.at(-1)).toBe(100);
      expect([...composite.progress].sort((a, b) => a - b)).toEqual(composite.progress);
      expect(composite.peakRssBytes).toBeGreaterThan(256 * 1024 * 1024);
      expect(composite.cpuMs).toBeGreaterThan(0);
    });

    it("leaves no Chrome temporary folder behind", async () => {
      const left = (await chromeFolders()).filter((entry) => !chromeFoldersBefore.has(entry));
      expect(left).toEqual([]);
    });

    it("exports the clean mode with the same frames and the same sound", async () => {
      const clean = await exportReel("clicks-clean", "short-speech", edit, FILES, CLEAN);
      expect(clean.route).toEqual({ path: "composite", mode: "clean" });
      const scores = await frameSsim(clean.output, single.output, "clicks-clean");
      console.log(
        `clicks-clean: SSIM mean ${(scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(5)}, min ${Math.min(...scores).toFixed(5)}`,
      );
      expect(scores).toHaveLength(reelFrames(edit.duration));
      // Not held to the bound (the footage skips the single call's JPEG step);
      // far above anything a wrong frame or a misplaced layer would score.
      expect(Math.min(...scores)).toBeGreaterThan(0.97);
      expect(await decodedSound(clean.output)).toEqual(await decodedSound(single.output));
    });
  });

  // The ten-second fixture reel, a person talking, with two big words behind
  // her: two cut-out spans, each with its real MODNet mask (the committed
  // model), so the ffmpeg blend is held against the page's CSS blend where it
  // matters, at the person's edge over the words.
  describe("a reel with two big words behind the speaker", () => {
    const SOURCE = fixturePath("retime", "source.mp4", "speech-ten");
    let edit: Edit;
    let files: RenderFiles;
    let single: Exported;
    let composite: Exported;

    beforeAll(async () => {
      const fixture = await fixtureEdit("speech-ten");
      const word = (id: string, text: string, from: string, to: string, y: number) => ({
        id,
        kind: "word" as const,
        text,
        position: { x: 120, y },
        size: 300,
        start: { word: from },
        end: { word: to, edge: "end" as const },
      });
      edit = withMasks(
        {
          ...fixture.edit,
          tracks: {
            ...fixture.edit.tracks,
            behind: [
              word("behind-earn", "EARN", "w0005", "w0008", 620),
              word("behind-work", "WORK", "w0028", "w0032", 700),
            ],
          },
        },
        fixture.transcript,
        fixture.headTrack,
      );
      const masks: Record<string, string> = {};
      for (const mask of edit.inputs.masks!) {
        const output = join(dir, `${mask.fingerprint}.mp4`);
        const call = maskToolCall(
          {
            input: SOURCE,
            start: mask.start,
            end: mask.end,
            cropTop: spanCropTop(fixture.headTrack, mask),
            threads: 4,
            output,
          },
          { tools: REAL_TOOLS, env: {} },
        );
        await run(call.file, call.args);
        masks[`masks/${mask.fingerprint}.mp4`] = output;
      }
      files = { footage: SOURCE, masks };
      single = await exportReel("behind-single", "speech-ten", edit, files, SINGLE);
      composite = await exportReel("behind-composite", "speech-ten", edit, files, MATCH);
    });

    it("has two cut-out spans", () => {
      expect(edit.inputs.masks).toHaveLength(2);
    });

    it("matches on every frame and in every sample", async () => {
      await expectSameExport("behind", composite, single, edit);
    });
  });
});

// The sound page alone, at a reel length the page's earlier fractional rate
// broke: 187 frames ran at 210/187 fps, HyperFrames read the file back at
// another rate and trimmed the sound to 0.3 s of 6.2 s (the same fault left
// 2.2 s of a 1683-frame reel's 56.1 s). 187 shares no factor with 30, so the
// page runs at 30 fps.
describe("the sound page of a reel whose length is no whole number of seconds", () => {
  const FRAMES = 187;

  it("holds every packet of the reel, and the cut keeps them all", async () => {
    const { edit: whole, transcript, headTrack } = await fixtureEdit("speech-ten");
    // The ten-second reel, ended early: 6.22 s is 187 export frames.
    const edit = { ...whole, duration: 6.22 };
    expect(reelFrames(edit.duration)).toBe(FRAMES);
    expect(soundPageFps(FRAMES)).toBe("30");
    const pageDir = join(dir, "sound-187");
    const projectDir = join(pageDir, "project");
    const page = join(pageDir, "sound.mp4");
    const cut = join(pageDir, "sound.m4a");
    const { html, assets } = build(
      edit,
      transcript,
      headTrack,
      ISSEBYA_PRESET,
      await editMeasurer(edit.font_pair),
      { layer: "sound" },
    );
    await writeRenderProject({
      dir: projectDir,
      html,
      assets,
      files: { footage: fixturePath("retime", "source.mp4", "speech-ten") },
    });
    await withChromeTmp((chromeTmp) =>
      run(
        REAL_TOOLS.hyperframes[0],
        [
          REAL_TOOLS.hyperframes[1],
          ...layerArgs({ layer: "sound", projectDir, output: page, frames: FRAMES }),
        ],
        {
          env: { ...renderEnv(process.env), ...renderScratchEnv(pageDir), TMPDIR: chromeTmp },
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
    await run(REAL_TOOLS.ffmpeg, soundCutArgs({ input: page, output: cut, frames: FRAMES }));
    const { stdout: counted } = await run(REAL_TOOLS.ffprobe, soundPacketsArgs(cut));
    expect(() => assertSoundCovers(counted, FRAMES)).not.toThrow();
    expect(Number(counted)).toBe(soundPackets(FRAMES));
    // The sound lasts the reel, to the millisecond the container keeps.
    expect(Number(await probe(cut, "stream=duration", "a:0"))).toBeCloseTo(FRAMES / 30, 2);
  });
});
