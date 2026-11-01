import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Edit, ISSEBYA_PRESET, resolveTimeline } from "@edit-issebya/edit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REAL_TOOLS, formatDuration, streamInfo } from "../pipeline/tools-test-support.ts";
import { recordingSteps, stepContext } from "../recording-steps.ts";
import { type ChildRun, type SpawnTool, runToolsStep, spawnChild } from "../step-runner.ts";
import { parseTimeReport } from "../time-report.ts";
import { renderExport } from "./render-step.ts";
import { fixtureEdit, fixturePath } from "./render-test-support.ts";

// The real HyperFrames render of the fixture reel (2.69 s), through the step
// runner exactly as a render job runs it: the voice keeps its level, the
// clicks land where the edit's sound track puts them, and the row's peak
// memory comes from sampling the whole process tree.
const run = promisify(execFile);
const SOURCE = fixturePath("retime", "source.mp4");
const FILES = { footage: SOURCE, cutout: fixturePath("remove_background", "subject.webm") };
const RANGE = { start: 0, end: 3 };
const REEL_SECONDS = 2.69;
const CLICK_WORDS = ["w0005", "w0009"];
const ONSET_TOLERANCE_S = 0.02;

let dir: string;

interface Rendered {
  output: string;
  child: ChildRun;
  peakRssBytes: number | null;
}

async function render(name: string, edit: Edit): Promise<Rendered> {
  const { transcript, headTrack } = await fixtureEdit();
  const renderDir = join(dir, name);
  const { steps, calls } = recordingSteps();
  let child: ChildRun | null = null;
  // The real spawner, keeping its raw run for the single-process report.
  const spawnTool: SpawnTool = async (call, signal, log) => {
    child = await spawnChild(call, signal, log);
    return child;
  };
  let output = "";
  await runToolsStep(
    stepContext(steps),
    {
      name: "render",
      outputs: [join(renderDir, "export.mp4")],
      async work(tool) {
        ({ output } = await renderExport({
          tool,
          tools: REAL_TOOLS,
          dir: renderDir,
          edit,
          transcript,
          headTrack,
          files: FILES,
          range: RANGE,
        }));
        return { what: "exported" };
      },
    },
    spawnTool,
  );
  const done = calls.find((call) => call.call === "done");
  if (!child || done?.call !== "done") throw new Error(`${name}: the render step did not finish`);
  return { output, child, peakRssBytes: done.measurements.peak_rss_bytes };
}

async function ffmpegStderr(args: string[]): Promise<string> {
  const { stderr } = await run(REAL_TOOLS.ffmpeg, ["-hide_banner", "-nostats", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stderr;
}

// The source is mono and the export stereo with the voice in both channels
// (dual mono). EBU R128 sums the channels' power, so the same voice reads
// 3 LU louder as dual mono, and ffmpeg's stereo downmix changes its level
// too. Every measurement therefore takes the first channel alone: the voice
// itself, compared like for like.
const FIRST_CHANNEL = "pan=mono|c0=c0";

// EBU R128 integrated loudness of the first `seconds` of the first channel, in LUFS.
async function integratedLoudness(path: string, seconds: number): Promise<number> {
  const stderr = await ffmpegStderr([
    "-t",
    String(seconds),
    "-i",
    path,
    "-af",
    `${FIRST_CHANNEL},ebur128`,
    "-f",
    "null",
    "-",
  ]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const match = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  if (!match) throw new Error(`no integrated loudness for ${path}`);
  return Number(match[1]);
}

const RATE = 48_000;

// 48 kHz float samples of the first `seconds` of the first channel.
function pcm(path: string, seconds: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    execFile(
      REAL_TOOLS.ffmpeg,
      [
        "-v",
        "error",
        "-t",
        String(seconds),
        "-i",
        path,
        "-af",
        FIRST_CHANNEL,
        "-ar",
        String(RATE),
        "-f",
        "f32le",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        const copy = new Uint8Array(stdout).slice();
        resolve(new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)));
      },
    );
  });
}

// Click onsets in seconds: the export minus the source leaves the clicks and
// only AAC re-encoding residue of the voice. 1 ms RMS windows; an onset is a
// window rising above 60 times the median residual. Measured on this fixture:
// the voice's residue peaks near 24 times the median and the clicks (mixed at
// -13 dB) near 175 times, so 60 sits well clear of both. The click sample has
// a second transient (the button's release) about 0.1 s in, so every window
// within one click's length of an onset belongs to that click; two clicks are
// at least 0.25 s apart (the preset's gap), longer than one click.
const ONSET_FACTOR = 60;

function clickOnsets(exported: Float32Array, source: Float32Array): number[] {
  const window = RATE / 1000;
  const length = Math.min(exported.length, source.length);
  const rms: number[] = [];
  for (let start = 0; start + window <= length; start += window) {
    let sum = 0;
    for (let i = start; i < start + window; i += 1) {
      const d = exported[i]! - source[i]!;
      sum += d * d;
    }
    rms.push(Math.sqrt(sum / window));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const bound = ONSET_FACTOR * (sorted[Math.floor(sorted.length / 2)] ?? 0);
  const clickMs = Math.round(ISSEBYA_PRESET.sounds.click.durationSeconds * 1000);
  const onsets: number[] = [];
  let lastOnsetMs = -Infinity;
  for (const [index, value] of rms.entries()) {
    if (value > bound && index - lastOnsetMs > clickMs) {
      onsets.push(index / 1000);
      lastOnsetMs = index;
    }
  }
  return onsets;
}

async function audioCodec(path: string): Promise<string | undefined> {
  const { stdout } = await run(REAL_TOOLS.ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "csv=p=0",
    path,
  ]);
  return stdout.trim() || undefined;
}

let silent: Rendered;
let clicks: Rendered;
let clickEdit: Edit;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-tools-"));
  const { edit } = await fixtureEdit();
  clickEdit = structuredClone(edit);
  clickEdit.tracks.sounds = CLICK_WORDS.map((word, index) => ({
    id: `click-${index + 1}`,
    sound: "click" as const,
    start: { word, edge: "start" as const },
    end: { word, edge: "start" as const, offset: 0.23 },
  }));
  silent = await render("silent", edit);
  clicks = await render("clicks", clickEdit);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the real render", () => {
  it("is a 1080x1920, 30 fps H.264 MP4 of the reel's length with AAC audio", async () => {
    const video = await streamInfo(silent.output);
    expect(video).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    const { stdout } = await run(REAL_TOOLS.ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate",
      "-of",
      "csv=p=0",
      silent.output,
    ]);
    expect(stdout.trim()).toBe("30/1");
    expect(Math.abs((await formatDuration(silent.output)) - REEL_SECONDS)).toBeLessThan(0.1);
    expect(await audioCodec(silent.output)).toBe("aac");
  });

  it("keeps the voice at its own level, within 0.5 LU of the retimed source", async () => {
    const exported = await integratedLoudness(silent.output, REEL_SECONDS);
    const source = await integratedLoudness(SOURCE, REEL_SECONDS);
    console.log(`loudness: export ${exported} LUFS, source ${source} LUFS`);
    expect(Math.abs(exported - source)).toBeLessThanOrEqual(0.5);
  });

  it("lands each click within 20 ms of where the sound track puts it", async () => {
    const { transcript } = await fixtureEdit();
    const timeline = resolveTimeline(clickEdit, transcript);
    const expected = clickEdit.tracks.sounds.map((item) => timeline.get(item.id)!.start);
    const onsets = clickOnsets(
      await pcm(clicks.output, REEL_SECONDS),
      await pcm(SOURCE, REEL_SECONDS),
    );
    console.log(`clicks: expected ${expected.join(", ")} s, heard ${onsets.join(", ")} s`);
    for (const start of expected) {
      expect(onsets.some((onset) => Math.abs(onset - start) <= ONSET_TOLERANCE_S)).toBe(true);
    }
    for (const onset of onsets) {
      expect(expected.some((start) => Math.abs(onset - start) <= ONSET_TOLERANCE_S)).toBe(true);
    }
  });

  it("records the whole process tree's peak memory, above the largest single process", () => {
    for (const rendered of [silent, clicks]) {
      const single = parseTimeReport(process.platform, rendered.child.report);
      console.log(
        `memory: group ${rendered.child.groupPeakBytes} B, single ${single?.peakRssBytes} B`,
      );
      expect(rendered.child.groupPeakBytes).not.toBeNull();
      expect(rendered.peakRssBytes).toBe(rendered.child.groupPeakBytes);
      expect(rendered.child.groupPeakBytes!).toBeGreaterThan(single!.peakRssBytes);
    }
  });
});
