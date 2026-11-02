// `test:tools` only, on the owner's Mac: vseg built from source and run on a
// 3-second span of the committed person clip (read only, never modified).
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REAL_TOOLS } from "../pipeline/tools-test-support.ts";
import { maskToolCall } from "./mask-tool.ts";

const run = promisify(execFile);
const PERSON = fileURLToPath(
  new URL("../../../../fixtures/footage/short-person.mp4", import.meta.url),
);
const BUILD = fileURLToPath(new URL("../../scripts/build-vseg.sh", import.meta.url));

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mask-tool-"));
  await run("bash", [BUILD]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The mean mask value (0 to 255) of a box over every frame.
async function meanOf(file: string, box: string): Promise<number> {
  const { stderr } = await run(REAL_TOOLS.ffmpeg, [
    "-hide_banner",
    "-v",
    "info",
    "-i",
    file,
    "-vf",
    `crop=${box},scale=in_range=limited:out_range=full,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    "-f",
    "null",
    "-",
  ]);
  const values = [...stderr.matchAll(/YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  expect(values.length).toBeGreaterThan(0);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe.runIf(process.platform === "darwin")("vseg", () => {
  it("masks 3 seconds of the person clip: H.264, its size, its frames, the person white", async () => {
    const output = join(dir, "mask.mp4");
    const call = maskToolCall(
      { input: PERSON, start: 0.5, end: 3.5, output },
      { tools: REAL_TOOLS, env: {} },
    );
    const started = performance.now();
    await run(call.file, call.args);
    expect(performance.now() - started).toBeLessThan(15_000);

    const { stdout } = await run(REAL_TOOLS.ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=codec_name,width,height,nb_read_frames",
      "-of",
      "json",
      output,
    ]);
    const [stream] = (
      JSON.parse(stdout) as {
        streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[];
      }
    ).streams;
    expect(stream).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(Number(stream!.nb_read_frames)).toBe(90);
    // The face (the head box of the clip) is person; the top-left corner is not.
    expect(await meanOf(output, "160:160:520:700")).toBeGreaterThan(200);
    expect(await meanOf(output, "100:100:0:0")).toBeLessThan(30);
  });
});
