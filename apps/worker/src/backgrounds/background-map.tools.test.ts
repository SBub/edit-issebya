// `test:tools` only, on the owner's Mac: real ffmpeg on the fixture clip
// gives exactly the committed map the baseline golden is placed over.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REAL_TOOLS, realTool } from "../pipeline/tools-test-support.ts";
import {
  BACKGROUND_SETTINGS,
  backgroundArgs,
  backgroundsJson,
  mapFromRaw,
} from "./background-map.ts";
import { FIXTURE_BACKGROUNDS } from "./test-support.ts";

const SOURCE = fileURLToPath(
  new URL("../../../../fixtures/pipeline/retime/source.mp4", import.meta.url),
);

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "backgrounds-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the background map", () => {
  it("of the fixture clip equals the committed one", async () => {
    const raw = join(dir, "frames.rgb");
    await realTool({
      file: REAL_TOOLS.ffmpeg,
      args: backgroundArgs(SOURCE, raw, BACKGROUND_SETTINGS),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    const map = mapFromRaw(new Uint8Array(await readFile(raw)), BACKGROUND_SETTINGS);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
    expect(backgroundsJson(map)).toBe(await readFile(FIXTURE_BACKGROUNDS, "utf8"));
  });
});
