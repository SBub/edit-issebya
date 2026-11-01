import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeadSample } from "./head-sample.ts";
import { headTrack } from "./head-track.ts";
import { REAL_TOOLS, personCutOut, realTool } from "./tools-test-support.ts";

let dir: string;
let cutOut: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "head-track-tools-"));
  cutOut = await personCutOut(join(dir, "remove_background"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("head_track on the real cut-out", () => {
  it("finds the head in most samples of the person clip", async () => {
    const stepDir = join(dir, "head_track");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await mkdir(stepDir);
    const { what } = await headTrack.run({
      tool: realTool,
      tools: REAL_TOOLS,
      dir: stepDir,
      files: { "subject.webm": cutOut },
      settings: headTrack.settings,
      signal: new AbortController().signal,
    });
    const track = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await readFile(join(stepDir, "head-track.json"), "utf8"),
    ) as (HeadSample | null)[];
    // Four seconds at four samples a second.
    expect([16, 17]).toContain(track.length);
    const found = track.filter((sample): sample is HeadSample => sample !== null);
    expect(found.length / track.length).toBeGreaterThanOrEqual(0.8);
    for (const sample of found) {
      expect(sample.cx).toBeGreaterThanOrEqual(0);
      expect(sample.cx).toBeLessThanOrEqual(1080);
    }
    expect(what).toBe(
      `head tracked, ${track.length} samples, ${track.length - found.length} without a head`,
    );
    // The raw frames are removed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(stepDir)).toEqual(["head-track.json"]);
  });
});
