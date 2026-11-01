import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type R2Config, r2Endpoint, r2Storage } from "./r2.ts";

interface SentRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

// Answers every request with one fixed response and records what was sent:
// the SDK's request handler interface, no network.
function answering(statusCode: number, headers: Record<string, string> = {}, body = "") {
  const sent: SentRequest[] = [];
  const requestHandler = {
    async handle(request: SentRequest & { body?: unknown }) {
      sent.push({ method: request.method, path: request.path, headers: { ...request.headers } });
      if (request.body instanceof Readable) request.body.resume();
      return {
        response: { statusCode, headers, body: Readable.from([Buffer.from(body)]) },
      };
    },
  } as unknown as R2Config["requestHandler"];
  const storage = r2Storage({
    accountId: "abc",
    bucket: "bucket",
    accessKeyId: "dummy-id",
    secretAccessKey: "dummy-secret",
    requestHandler,
  });
  return { storage, sent };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "r2-storage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("r2Endpoint", () => {
  it("gives the plain and the jurisdictional form", () => {
    expect(r2Endpoint("abc")).toBe("https://abc.r2.cloudflarestorage.com");
    expect(r2Endpoint("abc", "eu")).toBe("https://abc.eu.r2.cloudflarestorage.com");
    expect(r2Endpoint("abc", " ")).toBe("https://abc.r2.cloudflarestorage.com");
  });
});

describe("r2Storage.signUpload", () => {
  it("presigns a PUT on the R2 host without checksum parameters", async () => {
    const storage = r2Storage({
      accountId: "abc",
      bucket: "bucket",
      jurisdiction: "eu",
      accessKeyId: "dummy-id",
      secretAccessKey: "dummy-secret",
    });
    const url = new URL(
      await storage.signUpload("dev/reels/r1/source/original.mp4", {
        contentType: "video/mp4",
        expiresInSeconds: 900,
      }),
    );
    expect(url.host).toBe("abc.eu.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/bucket/dev/reels/r1/source/original.mp4");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
    expect(names.some((name) => name.startsWith("x-amz-checksum"))).toBe(false);
    expect(names).not.toContain("x-amz-sdk-checksum-algorithm");
  });
});

describe("r2Storage.signDownload", () => {
  const storage = r2Storage({
    accountId: "abc",
    bucket: "bucket",
    accessKeyId: "dummy-id",
    secretAccessKey: "dummy-secret",
  });

  it("presigns a GET for the given time, inline without a name", async () => {
    const url = new URL(await storage.signDownload("dev/a.mp4", { expiresInSeconds: 120 }));
    expect(url.pathname).toBe("/bucket/dev/a.mp4");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("response-content-disposition")).toBeNull();
  });

  it("serves the object as an attachment under the given name", async () => {
    const url = new URL(
      await storage.signDownload("dev/a.mp4", { expiresInSeconds: 60, fileName: "reel-1.mp4" }),
    );
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="reel-1.mp4"',
    );
  });

  it("refuses a name that would need quoting", async () => {
    await expect(
      storage.signDownload("dev/a.mp4", { expiresInSeconds: 60, fileName: 'a"; x=.mp4' }),
    ).rejects.toThrow(/invalid download name/);
  });
});

describe("r2Storage.head", () => {
  it("returns the size and the unquoted ETag", async () => {
    const { storage } = answering(200, {
      "content-length": "12",
      etag: '"9e107d9d372bb6826bd81d3542a419d6"',
    });
    expect(await storage.head("dev/a.mp4")).toEqual({
      bytes: 12,
      etag: "9e107d9d372bb6826bd81d3542a419d6",
    });
  });

  it("answers null for a missing object", async () => {
    const { storage } = answering(404);
    expect(await storage.head("dev/a.mp4")).toBeNull();
  });
});

describe("r2Storage.putFileIfAbsent", () => {
  it("sends If-None-Match: * with the file's length", async () => {
    const path = join(dir, "out.bin");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    await writeFile(path, "hello");
    const { storage, sent } = answering(200, { etag: '"x"' });
    expect(await storage.putFileIfAbsent("dev/cache/s/fp/out.bin", path)).toBe("written");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/bucket/dev/cache/s/fp/out.bin" });
    expect(sent[0]!.headers["if-none-match"]).toBe("*");
    expect(sent[0]!.headers["content-length"]).toBe("5");
  });

  it("maps 412 to exists", async () => {
    const path = join(dir, "out.bin");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    await writeFile(path, "hello");
    const { storage } = answering(
      412,
      { "content-type": "application/xml" },
      "<Error><Code>PreconditionFailed</Code><Message>taken</Message></Error>",
    );
    expect(await storage.putFileIfAbsent("dev/cache/s/fp/out.bin", path)).toBe("exists");
  });
});

describe("r2Storage.putIfAbsent", () => {
  it("sends the bytes with If-None-Match: *", async () => {
    const { storage, sent } = answering(200, { etag: '"x"' });
    expect(
      await storage.putIfAbsent("dev/reels/r1/versions/v1.json", new TextEncoder().encode("{}"), {
        contentType: "application/json",
      }),
    ).toBe("written");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/bucket/dev/reels/r1/versions/v1.json" });
    expect(sent[0]!.headers["if-none-match"]).toBe("*");
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
  });

  it("maps 412 to exists", async () => {
    const { storage } = answering(
      412,
      { "content-type": "application/xml" },
      "<Error><Code>PreconditionFailed</Code><Message>taken</Message></Error>",
    );
    expect(await storage.putIfAbsent("dev/reels/r1/versions/v1.json", new Uint8Array([1]))).toBe(
      "exists",
    );
  });
});

describe("r2Storage.getFile", () => {
  it("writes the body under the final name only", async () => {
    const { storage } = answering(200, { "content-length": "3" }, "abc");
    const path = join(dir, "in.bin");
    expect(await storage.getFile("dev/a.bin", path)).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(await readdir(dir)).toEqual(["in.bin"]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(await readFile(path, "utf8")).toBe("abc");
  });

  it("answers false and leaves no .part for a missing object", async () => {
    const { storage } = answering(
      404,
      { "content-type": "application/xml" },
      "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
    );
    expect(await storage.getFile("dev/a.bin", join(dir, "in.bin"))).toBe(false);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(await readdir(dir)).toEqual([]);
  });
});
