import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { fakeStorage } from "@edit-issebya/storage";
import { GET, HEAD, PUT } from "./route";

const KEY = ["dev", "reels", "r1", "source", "original.mp4"];
let root: string;

function context(key: string[]) {
  return { params: Promise.resolve({ key }) };
}

function store() {
  return fakeStorage({
    root: join(root, ".e2e-storage"),
    uploadUrlBase: "/studio/api/e2e-storage-mock/",
  });
}

const part = (uploadId: string, partNumber: number | string) =>
  `?uploadId=${uploadId}&partNumber=${partNumber}`;

function putPart(key: string[], body: Uint8Array<ArrayBuffer>, query: string) {
  return PUT(new Request(`http://x/${query}`, { method: "PUT", body }), context(key));
}

// An object stored through a one-part multipart upload, as the browser does.
async function put(key: string[], body: Uint8Array<ArrayBuffer>) {
  const joined = key.join("/");
  const { uploadId } = await store().createMultipartUpload(joined, { contentType: "video/mp4" });
  const answer = await putPart(key, body, part(uploadId, 1));
  const etag = answer.headers.get("ETag")!.replaceAll('"', "");
  await store().completeMultipartUpload(joined, { uploadId, parts: [{ partNumber: 1, etag }] });
  return answer;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storage-route-"));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
  await writeFile(join(root, "turbo.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("without the exact flag", () => {
  for (const flag of [undefined, "1", "TRUE"]) {
    it(`answers 404 to every method (${String(flag)})`, async () => {
      vi.stubEnv("E2E_MOCK_STORAGE", flag);
      expect((await putPart(KEY, new Uint8Array([1]), part("u", 1))).status).toBe(404);
      expect((await GET(new Request("http://x/"), context(KEY))).status).toBe(404);
      expect((await HEAD(new Request("http://x/"), context(KEY))).status).toBe(404);
    });
  }
});

describe("with E2E_MOCK_STORAGE=true", () => {
  beforeEach(() => {
    vi.stubEnv("E2E_MOCK_STORAGE", "true");
  });

  it("stores a part PUT, answering its quoted MD5 as the ETag", async () => {
    const key = KEY.join("/");
    const { uploadId } = await store().createMultipartUpload(key, { contentType: "video/mp4" });
    const body = new Uint8Array([1, 2, 3]);
    const answer = await putPart(KEY, body, part(uploadId, 2));
    expect(answer.status).toBe(200);
    const md5 = createHash("md5").update(body).digest("hex");
    expect(answer.headers.get("ETag")).toBe(`"${md5}"`);
    expect(answer.headers.get("Access-Control-Expose-Headers")).toBe("ETag");
    expect(await store().listUploadParts(key, { uploadId })).toEqual([
      { partNumber: 2, etag: md5, bytes: 3 },
    ]);
  });

  it("round-trips a completed upload through GET and HEAD", async () => {
    const body = new Uint8Array([1, 2, 3]);
    expect((await put(KEY, body)).status).toBe(200);
    const read = await GET(new Request("http://x/"), context(KEY));
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
    const head = await HEAD(new Request("http://x/"), context(KEY));
    expect(head.headers.get("Content-Length")).toBe("3");
  });

  it("answers 400 without an upload id or part number, and 404 for an unknown upload", async () => {
    const body = new Uint8Array([1]);
    expect((await putPart(KEY, body, "")).status).toBe(400);
    expect((await putPart(KEY, body, "?uploadId=u")).status).toBe(400);
    expect((await putPart(KEY, body, part("u", 0))).status).toBe(400);
    expect((await putPart(KEY, body, part("u", 10001))).status).toBe(400);
    expect((await putPart(KEY, body, part("a%2Fb", 1))).status).toBe(400);
    expect((await putPart(KEY, body, part("unknown", 1))).status).toBe(404);
  });

  it("answers 400 to a key that could leave the folder", async () => {
    const query = part("u", 1);
    expect((await putPart(["..", "x"], new Uint8Array([1]), query)).status).toBe(400);
    expect((await putPart(["a", "..", "..", "x"], new Uint8Array([1]), query)).status).toBe(400);
  });

  it("answers 404 for a missing object", async () => {
    expect((await GET(new Request("http://x/"), context(["missing.mp4"]))).status).toBe(404);
  });

  describe("Range", () => {
    const VIDEO = ["dev", "cache", "preview_copies", "f", "footage-preview.mp4"];
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const ranged = (range: string) =>
      GET(new Request("http://x/", { headers: { range } }), context(VIDEO));

    beforeEach(async () => {
      await put(VIDEO, bytes);
    });

    it("serves the whole object with Accept-Ranges and a guessed type", async () => {
      const read = await GET(new Request("http://x/"), context(VIDEO));
      expect(read.status).toBe(200);
      expect(read.headers.get("Accept-Ranges")).toBe("bytes");
      expect(read.headers.get("Content-Type")).toBe("video/mp4");
    });

    it("answers 206 with the inclusive slice", async () => {
      const read = await ranged("bytes=2-5");
      expect(read.status).toBe(206);
      expect(read.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(read.headers.get("Content-Length")).toBe("4");
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]));
    });

    it("answers an open-ended range to the end", async () => {
      const read = await ranged("bytes=7-");
      expect(read.status).toBe(206);
      expect(read.headers.get("Content-Range")).toBe("bytes 7-9/10");
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
    });

    it("answers 416 to a range past the end", async () => {
      const read = await ranged("bytes=10-");
      expect(read.status).toBe(416);
      expect(read.headers.get("Content-Range")).toBe("bytes */10");
    });
  });

  describe("download", () => {
    const EXPORT = ["dev", "exports", "r1", "e1.mp4"];
    const read = (query: string, headers: Record<string, string> = {}) =>
      GET(new Request(`http://x/${query}`, { headers }), context(EXPORT));

    beforeEach(async () => {
      await put(EXPORT, new Uint8Array([1, 2, 3, 4]));
    });

    it("answers an attachment for a good download name, whole and ranged", async () => {
      const whole = await read("?download=reel-v2-20261101-1200.mp4");
      expect(whole.headers.get("Content-Disposition")).toBe(
        'attachment; filename="reel-v2-20261101-1200.mp4"',
      );
      const ranged = await read("?download=reel.mp4", { range: "bytes=0-1" });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("Content-Disposition")).toBe('attachment; filename="reel.mp4"');
    });

    it("adds no disposition without a name or with a bad one", async () => {
      expect((await read("")).headers.get("Content-Disposition")).toBeNull();
      expect(
        (await read(`?download=${encodeURIComponent('a"; b.mp4')}`)).headers.get(
          "Content-Disposition",
        ),
      ).toBeNull();
    });
  });
});
