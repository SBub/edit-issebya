// The render double's process (E2E_MOCK_RENDER=true only): prints the
// `@hf-progress` lines of a real HyperFrames render (the committed sample),
// spread evenly over E2E_MOCK_RENDER_SECONDS seconds (unset or 0: all at
// once), then copies the stub MP4 to the output, so a spec sees the render
// step's progress rise live without a Chrome render.
//
// Arguments: <stub mp4> <output>
import { copyFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.E2E_MOCK_RENDER !== "true") {
  console.error("fake-render: runs only under E2E_MOCK_RENDER=true");
  process.exit(2);
}
const [stub, output] = process.argv.slice(2);
if (!stub || !output) {
  console.error("usage: fake-render <stub mp4> <output>");
  process.exit(2);
}

const raw = process.env.E2E_MOCK_RENDER_SECONDS?.trim() || "0";
const seconds = Number(raw);
if (!Number.isFinite(seconds) || seconds < 0) {
  console.error(`fake-render: E2E_MOCK_RENDER_SECONDS must be seconds, got ${raw}`);
  process.exit(2);
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed sample
const sample = await readFile(new URL("../progress-testdata/render.txt", import.meta.url), "utf8");
const lines = sample.split("\n").filter((line) => line.trim().startsWith("@hf-progress "));
const gapMs = lines.length > 0 ? (seconds * 1000) / lines.length : 0;
for (const line of lines) {
  console.log(line);
  if (gapMs > 0) await sleep(gapMs);
}
await copyFile(stub, output);
