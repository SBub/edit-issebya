import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SpawnTool } from "./step-runner.ts";

type Env = Record<string, string | undefined>;

// A small committed MP4 (H.264 and AAC, about a second).
const FIXTURE = fileURLToPath(new URL("../../../fixtures/export/render.mp4", import.meta.url));

// The E2E stand-in for `hyperframes render`: copies the fixture to the path
// after `-o`, so the suite runs without Chrome. Anything but a render call is
// refused.
export function fakeRenderSpawn(fixture: string = FIXTURE): SpawnTool {
  return async (call) => {
    const output = call.args[call.args.indexOf("-o") + 1];
    if (!call.args.includes("render") || !call.args.includes("-o") || !output) {
      throw new Error(`fake render: not a render call: ${call.args.join(" ")}`);
    }
    await copyFile(fixture, output);
    return { code: 0, exitSignal: null, report: "", output: "", stdout: "", groupPeakBytes: null };
  };
}

// The fake only when E2E_MOCK_RENDER is exactly "true"; otherwise undefined,
// so the step runner spawns the real HyperFrames.
export function renderSpawnTool(env: Env = process.env): SpawnTool | undefined {
  return env.E2E_MOCK_RENDER === "true" ? fakeRenderSpawn() : undefined;
}
