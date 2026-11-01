import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRenderSpawn, renderSpawnTool } from "./fake-render.ts";

let dir: string;
const signal = new AbortController().signal;
const log = () => {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fake-render-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fakeRenderSpawn", () => {
  it("copies the fixture to the path after -o", async () => {
    const fixture = join(dir, "fixture.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(fixture, "fixture bytes");
    const output = join(dir, "out.mp4");
    const run = await fakeRenderSpawn(fixture)(
      { file: "node", args: ["hf.mjs", "render", "/p", "-o", output, "--quiet"] },
      signal,
      log,
    );
    expect(run.code).toBe(0);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readFile(output, "utf8")).toBe("fixture bytes");
  });

  it("copies the committed fixture by default", async () => {
    const output = join(dir, "out.mp4");
    await fakeRenderSpawn()(
      { file: "node", args: ["hf.mjs", "render", "/p", "-o", output] },
      signal,
      log,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
  });

  it("refuses a call that is not a render", async () => {
    await expect(
      fakeRenderSpawn()({ file: "node", args: ["hf.mjs", "transcribe", "-o", "/x"] }, signal, log),
    ).rejects.toThrow(/not a render call/);
    await expect(
      fakeRenderSpawn()({ file: "node", args: ["hf.mjs", "render", "/p"] }, signal, log),
    ).rejects.toThrow(/not a render call/);
  });
});

describe("renderSpawnTool", () => {
  it("is the fake only for exactly 'true'", () => {
    expect(renderSpawnTool({ E2E_MOCK_RENDER: "true" })).toBeTypeOf("function");
    for (const value of [undefined, "", "1", "TRUE", "yes"]) {
      expect(renderSpawnTool({ E2E_MOCK_RENDER: value })).toBeUndefined();
    }
  });
});
