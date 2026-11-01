import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInScratch } from "./scratch.ts";

const JOB_ID = "0b6f2a52-7d0e-4c55-9d4a-3c1f0e8a1b01";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scratch-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runInScratch", () => {
  it("runs the job in <root>/<jobId>, then removes it and logs the bytes freed", async () => {
    const lines: string[] = [];
    const result = await runInScratch(
      { root, jobId: JOB_ID, log: (line) => lines.push(line) },
      async (dir) => {
        expect(dir).toBe(join(root, JOB_ID));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp root
        await writeFile(join(dir, "a.bin"), new Uint8Array(1000));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp root
        await writeFile(join(dir, "b.bin"), new Uint8Array(1048));
        return "done";
      },
    );
    expect(result).toBe("done");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp root
    expect(existsSync(join(root, JOB_ID))).toBe(false);
    expect(lines).toEqual([`job ${JOB_ID}: scratch cleared, 2.0 KB freed`]);
  });

  it("removes the directory when the job fails, and rethrows", async () => {
    await expect(
      runInScratch({ root, jobId: JOB_ID, log: () => {} }, async (dir) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp root
        await writeFile(join(dir, "partial.bin"), new Uint8Array(10));
        throw new Error("render crashed");
      }),
    ).rejects.toThrow("render crashed");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp root
    expect(existsSync(join(root, JOB_ID))).toBe(false);
  });

  it("refuses a job id that is not a UUID before creating anything", async () => {
    await expect(
      runInScratch({ root, jobId: "../x", log: () => {} }, async () => "never"),
    ).rejects.toThrow("invalid job id");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp root
    expect(await readdir(root)).toEqual([]);
  });
});
