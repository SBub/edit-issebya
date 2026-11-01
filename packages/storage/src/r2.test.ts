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

describe("r2Storage.signUploadPart", () => {
  const storage = r2Storage({
    accountId: "abc",
    bucket: "bucket",
    jurisdiction: "eu",
    accessKeyId: "dummy-id",
    secretAccessKey: "dummy-secret",
  });

  it("presigns a part PUT on the R2 host without checksum parameters", async () => {
    const url = new URL(
      await storage.signUploadPart("dev/reels/r1/source/original.mp4", {
        uploadId: "up.load-1",
        partNumber: 3,
        expiresInSeconds: 900,
      }),
    );
    expect(url.host).toBe("abc.eu.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/bucket/dev/reels/r1/source/original.mp4");
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("uploadId")).toBe("up.load-1");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
    expect(names.some((name) => name.startsWith("x-amz-checksum"))).toBe(false);
    expect(names).not.toContain("x-amz-sdk-checksum-algorithm");
  });

  it("refuses a bad upload id or part number before signing", async () => {
    const key = "dev/reels/r1/source/original.mp4";
    for (const uploadId of ["", "a/b", "a?b", "a&b"]) {
      await expect(
        storage.signUploadPart(key, { uploadId, partNumber: 1, expiresInSeconds: 60 }),
      ).rejects.toThrow(/invalid upload id/);
    }
    for (const partNumber of [0, 10001, 1.5]) {
      await expect(
        storage.signUploadPart(key, { uploadId: "u", partNumber, expiresInSeconds: 60 }),
      ).rejects.toThrow(/invalid part number/);
    }
  });
});

// `<tag>inner</tag>`, so no test string is one long XML literal.
const xml = (tag: string, inner: string) => `<${tag}>${inner}</${tag}>`;

const NO_SUCH_UPLOAD = [
  404,
  { "content-type": "application/xml" },
  "<Error><Code>NoSuchUpload</Code><Message>gone</Message></Error>",
] as const;

describe("r2Storage multipart", () => {
  const KEY = "dev/reels/r1/source/original.mp4";

  it("creates an upload and returns its id", async () => {
    const { storage, sent } = answering(
      200,
      { "content-type": "application/xml" },
      xml("InitiateMultipartUploadResult", xml("Key", "k") + xml("UploadId", "abc-123")),
    );
    expect(await storage.createMultipartUpload(KEY, { contentType: "video/mp4" })).toEqual({
      uploadId: "abc-123",
    });
    expect(sent[0]).toMatchObject({ method: "POST", path: `/bucket/${KEY}` });
    expect(sent[0]!.headers["content-type"]).toBe("video/mp4");
  });

  it("lists parts sorted with unquoted ETags", async () => {
    const { storage, sent } = answering(
      200,
      { "content-type": "application/xml" },
      "<ListPartsResult><IsTruncated>false</IsTruncated>" +
        '<Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag><Size>5</Size></Part>' +
        '<Part><PartNumber>1</PartNumber><ETag>"aaa"</ETag><Size>10</Size></Part>' +
        "</ListPartsResult>",
    );
    expect(await storage.listUploadParts(KEY, { uploadId: "u1" })).toEqual([
      { partNumber: 1, etag: "aaa", bytes: 10 },
      { partNumber: 2, etag: "bbb", bytes: 5 },
    ]);
    expect(sent[0]).toMatchObject({ method: "GET", path: `/bucket/${KEY}` });
  });

  it("maps NoSuchUpload to null, missing and a quiet abort", async () => {
    const { storage } = answering(...NO_SUCH_UPLOAD);
    expect(await storage.listUploadParts(KEY, { uploadId: "u1" })).toBeNull();
    expect(
      await storage.completeMultipartUpload(KEY, {
        uploadId: "u1",
        parts: [{ partNumber: 1, etag: "aaa" }],
      }),
    ).toBe("missing");
    await expect(storage.abortMultipartUpload(KEY, { uploadId: "u1" })).resolves.toBeUndefined();
  });

  it("completes with the parts sorted and their ETags quoted", async () => {
    const bodies: string[] = [];
    const requestHandler = {
      async handle(request: { body?: unknown }) {
        bodies.push(typeof request.body === "string" ? request.body : String(request.body));
        return {
          response: {
            statusCode: 200,
            headers: { "content-type": "application/xml" },
            body: Readable.from([
              Buffer.from(xml("CompleteMultipartUploadResult", xml("Key", "k"))),
            ]),
          },
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
    expect(
      await storage.completeMultipartUpload(KEY, {
        uploadId: "u1",
        parts: [
          { partNumber: 2, etag: "bbb" },
          { partNumber: 1, etag: '"aaa"' },
        ],
      }),
    ).toBe("completed");
    const body = bodies[0]!;
    expect(body.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(
      body.indexOf("<PartNumber>2</PartNumber>"),
    );
    expect(body).toContain("<ETag>&quot;aaa&quot;</ETag>");
    expect(body).toContain("<ETag>&quot;bbb&quot;</ETag>");
  });

  it("refuses a bad upload id or part number before any request", async () => {
    const { storage, sent } = answering(200);
    await expect(storage.listUploadParts(KEY, { uploadId: "a/b" })).rejects.toThrow(
      /invalid upload id/,
    );
    await expect(
      storage.completeMultipartUpload(KEY, {
        uploadId: "u1",
        parts: [{ partNumber: 10001, etag: "a" }],
      }),
    ).rejects.toThrow(/invalid part number/);
    await expect(storage.abortMultipartUpload("../x", { uploadId: "u1" })).rejects.toThrow(
      /invalid storage key/,
    );
    expect(sent).toHaveLength(0);
  });
});

describe("r2Storage.signDownload", () => {
  const storage = r2Storage({
    accountId: "abc",
    bucket: "bucket",
    accessKeyId: "dummy-id",
    secretAccessKey: "dummy-secret",
  });

  it("presigns a GET that downloads as an attachment with the given name", async () => {
    const url = new URL(
      await storage.signDownload("dev/exports/r1/e1.mp4", {
        expiresInSeconds: 120,
        downloadName: "reel-v3-20261101-1200.mp4",
      }),
    );
    expect(url.pathname).toBe("/bucket/dev/exports/r1/e1.mp4");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="reel-v3-20261101-1200.mp4"',
    );
  });

  it("adds no disposition without a name and refuses a bad name", async () => {
    const url = new URL(await storage.signDownload("dev/a.mp4", { expiresInSeconds: 60 }));
    expect(url.searchParams.has("response-content-disposition")).toBe(false);
    await expect(
      storage.signDownload("dev/a.mp4", { expiresInSeconds: 60, downloadName: 'x"; y=.mp4' }),
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
      await storage.putIfAbsent("dev/reels/r/versions/v.json", new TextEncoder().encode("{}"), {
        contentType: "application/json",
      }),
    ).toBe("written");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/bucket/dev/reels/r/versions/v.json" });
    expect(sent[0]!.headers["if-none-match"]).toBe("*");
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
  });

  it("maps 412 to exists", async () => {
    const { storage } = answering(
      412,
      { "content-type": "application/xml" },
      "<Error><Code>PreconditionFailed</Code><Message>taken</Message></Error>",
    );
    expect(
      await storage.putIfAbsent("dev/reels/r/versions/v.json", new TextEncoder().encode("{}")),
    ).toBe("exists");
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
