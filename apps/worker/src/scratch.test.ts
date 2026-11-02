import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statfsFreeBytes } from "./disk-guard.ts";
import {
  directoryBytes,
  prepareScratchDir,
  scratchDirState,
  sweepStaleScratch,
  withJobScratch,
} from "./scratch.ts";

const JOB = "0b6f2a52-7d0e-4c55-9d4a-3c1f0e8a1b01";
let scratch: string;
let logs: string[];
const log = (message: string) => logs.push(message);

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "scratch-"));
  logs = [];
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
const write = (path: string, bytes: number) => writeFile(path, new Uint8Array(bytes));

describe("directoryBytes", () => {
  it("sums every file under the folder and gives 0 when it is missing", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await mkdir(join(scratch, "a", "b"), { recursive: true });
    await write(join(scratch, "a", "one"), 100);
    await write(join(scratch, "a", "b", "two"), 24);
    expect(await directoryBytes(join(scratch, "a"))).toBe(124);
    expect(await directoryBytes(join(scratch, "missing"))).toBe(0);
  });
});

describe("withJobScratch", () => {
  it("removes the job folder after a failure and rethrows the error", async () => {
    await expect(
      withJobScratch(
        scratch,
        JOB,
        async (dir) => {
          expect(dir).toBe(join(scratch, JOB));
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
          await mkdir(join(dir, "render-x", "frames-cache"), { recursive: true });
          await write(join(dir, "render-x", "frames-cache", "f.png"), 2048);
          throw new Error("render crashed");
        },
        log,
      ),
    ).rejects.toThrow("render crashed");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
    expect(logs).toEqual([`job ${JOB}: scratch removed, 2.0 KB freed`]);
  });

  it("removes the job folder after a success and returns the result", async () => {
    const result = await withJobScratch(
      scratch,
      JOB,
      async (dir) => {
        await write(join(dir, "out.mp4"), 10);
        return "done";
      },
      log,
    );
    expect(result).toBe("done");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
    expect(logs).toEqual([`job ${JOB}: scratch removed, 10 B freed`]);
  });

  it("refuses a job id that is not a UUID before any path is made", async () => {
    await expect(withJobScratch(scratch, "../escape", async () => "x", log)).rejects.toThrow(
      /not a UUID/,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });
});

describe("sweepStaleScratch", () => {
  it("removes UUID-named folders only", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await mkdir(join(scratch, JOB));
    await write(join(scratch, JOB, "left.mp4"), 5);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await mkdir(join(scratch, "other"));
    await write(join(scratch, "keep.txt"), 1);
    await sweepStaleScratch(scratch, log);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect((await readdir(scratch)).sort()).toEqual(["keep.txt", "other"]);
    expect(logs).toEqual([`worker: stale scratch of job ${JOB} removed, 5 B freed`]);
  });

  it("is fine when the scratch folder does not exist", async () => {
    await sweepStaleScratch(join(scratch, "missing"), log);
    expect(logs).toEqual([]);
  });
});

describe("prepareScratchDir", () => {
  it("creates a missing nested folder so the disk guard can read its volume", async () => {
    const dir = join(scratch, "missing", "prod");
    await expect(statfsFreeBytes(dir)).rejects.toThrow(/ENOENT/);
    const error = vi.fn();
    const exit = vi.fn();
    await prepareScratchDir(dir, { error, exit });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await statfsFreeBytes(dir)).toBeGreaterThan(0);
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("leaves an existing folder as it is", async () => {
    await write(join(scratch, "keep.txt"), 1);
    const exit = vi.fn();
    await prepareScratchDir(scratch, { error: vi.fn(), exit });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual(["keep.txt"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ["a regular file at the path", "file", ""],
    ["a regular file as a parent", "file", "child"],
  ])("exits 1 naming the path with %s", async (_, name, child) => {
    await write(join(scratch, name), 1);
    const dir = child ? join(scratch, name, child) : join(scratch, name);
    const error = vi.fn();
    const exit = vi.fn();
    await prepareScratchDir(dir, { error, exit });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledTimes(1);
    const message = error.mock.calls[0]![0] as string;
    expect(message).toContain(`worker: scratch folder ${dir} cannot be created: `);
    expect(message).not.toContain("\n");
  });
});

describe("scratchDirState", () => {
  it("reports an existing folder", async () => {
    expect(await scratchDirState(scratch)).toBe("exists");
  });

  it("reports a missing nested folder under a writable one without creating it", async () => {
    const dir = join(scratch, "missing", "prod");
    expect(await scratchDirState(dir)).toBe("can be created");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(existsSync(join(scratch, "missing"))).toBe(false);
  });

  it("refuses a regular file at the path or as a parent, naming the path", async () => {
    const file = join(scratch, "file");
    await write(file, 1);
    await expect(scratchDirState(file)).rejects.toThrow(`${file} is not a folder`);
    const child = join(file, "child");
    await expect(scratchDirState(child)).rejects.toThrow(child);
  });
});
