import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("..", import.meta.url).pathname;

async function filesMatching(pattern: RegExp): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the studio's own source folder
  const sources = (await readdir(SRC, { recursive: true })).filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
  );
  const matches: string[] = [];
  for (const file of sources) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the studio's own source files
    const text = await readFile(join(SRC, file), "utf8");
    if (pattern.test(text)) matches.push(file.split("\\").join("/"));
  }
  return matches.sort();
}

// Every object the studio writes gets a stored_files row: its one upload path
// completes through finish_upload, which records the source.
describe("studio write paths", () => {
  it("sign uploads only in the upload actions", async () => {
    expect(await filesMatching(/signUpload\(/)).toEqual(["app/upload-actions.ts"]);
  });

  it("put objects only in the storage mock route, which stands in for R2", async () => {
    expect(await filesMatching(/\.put\(/)).toEqual(["app/api/e2e-storage-mock/[...key]/route.ts"]);
  });
});
