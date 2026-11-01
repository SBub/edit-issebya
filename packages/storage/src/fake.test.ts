import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { e2eStorageRoot, fakeStorage, isE2EMockStorage } from "./fake.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fake-storage-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fakeStorage", () => {
  it("round-trips put, head, get, list and delete", async () => {
    const storage = fakeStorage({ root, uploadUrlBase: "/up/" });
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.put("dev/reels/a/source/original.mp4", body);
    await storage.put("dev/reels/b/source/original.mov", new Uint8Array([9]));

    expect(await storage.head("dev/reels/a/source/original.mp4")).toEqual({
      bytes: 5,
      etag: createHash("md5").update(body).digest("hex"),
    });
    expect(await storage.get("dev/reels/a/source/original.mp4")).toEqual(body);
    expect(await storage.list("dev/reels/")).toEqual([
      "dev/reels/a/source/original.mp4",
      "dev/reels/b/source/original.mov",
    ]);
    expect(await storage.list("dev/reels/b")).toEqual(["dev/reels/b/source/original.mov"]);

    await storage.delete("dev/reels/a/source/original.mp4");
    await storage.delete("dev/reels/a/source/original.mp4");
    expect(await storage.head("dev/reels/a/source/original.mp4")).toBeNull();
  });

  it("answers null for a missing key and an empty list for a missing root", async () => {
    const storage = fakeStorage({ root: join(root, "absent"), uploadUrlBase: "/up/" });
    expect(await storage.head("missing.mp4")).toBeNull();
    expect(await storage.get("missing.mp4")).toBeNull();
    expect(await storage.list("")).toEqual([]);
  });

  it("streams an object to a local file, and answers false for a missing one", async () => {
    const storage = fakeStorage({ root: join(root, "store"), uploadUrlBase: "/up/" });
    await storage.put("cache/a/fp/file.bin", new Uint8Array([7, 8, 9]));
    const local = join(root, "local");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    await mkdir(local);
    expect(await storage.getFile("cache/a/fp/file.bin", join(local, "file.bin"))).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(new Uint8Array(await readFile(join(local, "file.bin")))).toEqual(
      new Uint8Array([7, 8, 9]),
    );
    expect(await storage.getFile("cache/a/fp/missing.bin", join(local, "missing.bin"))).toBe(false);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect((await readdir(local)).sort()).toEqual(["file.bin"]);
  });

  it("puts a file only when the key is free, keeping the first content", async () => {
    const storage = fakeStorage({ root: join(root, "store"), uploadUrlBase: "/up/" });
    const first = join(root, "first.bin");
    const second = join(root, "second.bin");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    await writeFile(first, "first");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    await writeFile(second, "second, longer");
    expect(await storage.putFileIfAbsent("cache/s/fp/out.bin", first)).toBe("written");
    const stored = join(root, "store", "cache/s/fp/out.bin");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    const before = await stat(stored);
    expect(await storage.putFileIfAbsent("cache/s/fp/out.bin", second)).toBe("exists");
    expect(new TextDecoder().decode((await storage.get("cache/s/fp/out.bin"))!)).toBe("first");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect((await stat(stored)).mtimeMs).toBe(before.mtimeMs);
    // No temporary copy is left beside it.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(await readdir(join(root, "store", "cache/s/fp"))).toEqual(["out.bin"]);
    expect(await storage.list("")).toEqual(["cache/s/fp/out.bin"]);
  });

  it("puts bytes only when the key is free, keeping the first content", async () => {
    const storage = fakeStorage({ root: join(root, "store"), uploadUrlBase: "/up/" });
    const key = "reels/r/versions/v.json";
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(await storage.putIfAbsent(key, encode("first"))).toBe("written");
    const stored = join(root, "store", key);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    const before = await stat(stored);
    expect(await storage.putIfAbsent(key, encode("second, longer"))).toBe("exists");
    expect(new TextDecoder().decode((await storage.get(key))!)).toBe("first");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect((await stat(stored)).mtimeMs).toBe(before.mtimeMs);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(await readdir(join(root, "store", "reels/r/versions"))).toEqual(["v.json"]);
  });

  it("signs same-origin paths", async () => {
    const storage = fakeStorage({ root, uploadUrlBase: "/studio/api/e2e-storage-mock/" });
    expect(
      await storage.signUpload("reels/x/source/original.mp4", {
        contentType: "video/mp4",
        expiresInSeconds: 60,
      }),
    ).toBe("/studio/api/e2e-storage-mock/reels/x/source/original.mp4");
    expect(await storage.signDownload("a.mp4", { expiresInSeconds: 60 })).toBe(
      "/studio/api/e2e-storage-mock/a.mp4",
    );
  });

  it("refuses keys that could leave its root", async () => {
    const storage = fakeStorage({ root, uploadUrlBase: "/up/" });
    for (const key of ["../x", "a/../../x", "/abs", "a//b", "Upper.mp4", ""]) {
      await expect(storage.put(key, new Uint8Array([1]))).rejects.toThrow(/invalid storage key/);
      await expect(storage.head(key)).rejects.toThrow(/invalid storage key/);
    }
  });
});

describe("isE2EMockStorage", () => {
  it("is true only for exactly 'true'", () => {
    expect(isE2EMockStorage({ E2E_MOCK_STORAGE: "true" })).toBe(true);
    for (const value of ["TRUE", "1", " true", "", undefined]) {
      expect(isE2EMockStorage({ E2E_MOCK_STORAGE: value })).toBe(false);
    }
  });
});

describe("e2eStorageRoot", () => {
  it("finds turbo.json two levels up", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    await writeFile(join(root, "turbo.json"), "{}");
    const cwd = join(root, "apps", "worker");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    await mkdir(cwd, { recursive: true });
    expect(e2eStorageRoot(cwd)).toBe(join(root, ".e2e-storage"));
  });

  it("throws without a turbo.json above", () => {
    expect(() => e2eStorageRoot(root)).toThrow(/no turbo.json/);
  });
});
