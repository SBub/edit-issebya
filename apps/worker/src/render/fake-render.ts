// The render double's process (E2E_MOCK_RENDER=true only), so a spec sees the
// render step's progress rise live without a Chrome render. One process per
// tool call of the real render, each spread over its share of
// E2E_MOCK_RENDER_SECONDS seconds (unset or 0: all at once):
//
//   <stub mp4> <output>
//     The single call: prints the `@hf-progress` lines of a real HyperFrames
//     render (the committed sample), then copies the stub MP4 to the output.
//   layer <share> <output>
//     One layer page of the composite: the same lines over `share` of the
//     seconds, then a placeholder where the page's output goes (a file for a
//     path ending `.mp4`, else a folder with one file).
//   ffmpeg <share> <frames> <stub mp4 | -> <output>
//     One ffmpeg pass of the composite: `frame=N` progress reports up to
//     `frames` over `share` of the seconds and `progress=end`, then the stub
//     copied to the output (`-`: a placeholder).
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

if (process.env.E2E_MOCK_RENDER !== "true") {
  refuse("fake-render: runs only under E2E_MOCK_RENDER=true");
}

const raw = process.env.E2E_MOCK_RENDER_SECONDS?.trim() || "0";
const seconds = Number(raw);
if (!Number.isFinite(seconds) || seconds < 0) {
  refuse(`fake-render: E2E_MOCK_RENDER_SECONDS must be seconds, got ${raw}`);
}

function numberOf(text: string | undefined, name: string): number {
  const value = Number(text);
  if (text === undefined || !Number.isFinite(value) || value < 0) {
    refuse(`fake-render: ${name} must be a number, got ${text}`);
  }
  return value;
}

// Prints the lines evenly over `overSeconds`.
async function print(lines: readonly string[], overSeconds: number): Promise<void> {
  const gapMs = lines.length > 0 ? (overSeconds * 1000) / lines.length : 0;
  for (const line of lines) {
    console.log(line);
    if (gapMs > 0) await sleep(gapMs);
  }
}

async function sampleLines(): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed sample
  const sample = await readFile(
    new URL("../progress-testdata/render.txt", import.meta.url),
    "utf8",
  );
  return sample.split("\n").filter((line) => line.trim().startsWith("@hf-progress "));
}

const USAGE =
  "usage: fake-render <stub mp4> <output> | layer <share> <output> | ffmpeg <share> <frames> <stub mp4 | -> <output>";
const args = process.argv.slice(2);

if (args[0] === "layer") {
  const [, share, output] = args;
  if (!output) refuse(USAGE);
  await print(await sampleLines(), seconds * numberOf(share, "share"));
  if (output.endsWith(".mp4")) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the double's own output
    await writeFile(output, "sound");
  } else {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the double's own output
    await mkdir(output, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the double's own output
    await writeFile(join(output, "frame_000001.png"), "frame");
  }
} else if (args[0] === "ffmpeg") {
  const [, share, frames, stub, output] = args;
  if (!stub || !output) refuse(USAGE);
  const total = numberOf(frames, "frames");
  const REPORTS = 20;
  const lines = Array.from(
    { length: REPORTS },
    (_, index) => `frame=${Math.round((total * (index + 1)) / REPORTS)}`,
  );
  await print(lines, seconds * numberOf(share, "share"));
  console.log("progress=end");
  if (stub === "-") {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the double's own output
    await writeFile(output, "pass");
  } else {
    await copyFile(stub, output);
  }
} else {
  const [stub, output] = args;
  if (!stub || !output) refuse(USAGE);
  await print(await sampleLines(), seconds);
  await copyFile(stub, output);
}
