import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { personCutOut, rawAlphaFrame, streamTags, videoStream } from "./tools-test-support.ts";

let dir: string;
let cutOut: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "remove-background-tools-"));
  cutOut = await personCutOut(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("remove_background with the real HyperFrames", () => {
  it("cuts the person out to VP9 with alpha in WebM", async () => {
    expect(cutOut.endsWith(".webm")).toBe(true);
    expect(await videoStream(cutOut)).toMatchObject({ codec_name: "vp9" });
    expect((await streamTags(cutOut)).alpha_mode).toBe("1");
  });

  it("holds both a transparent background and an opaque person at 2 seconds", async () => {
    const plane = await rawAlphaFrame(cutOut, 2, 270, 480);
    expect(plane.length).toBe(270 * 480);
    expect(plane.includes(0)).toBe(true);
    expect(plane.includes(255)).toBe(true);
  });
});
