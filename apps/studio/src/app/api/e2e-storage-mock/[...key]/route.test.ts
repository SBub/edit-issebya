import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD, PUT } from "./route";

const KEY = ["dev", "reels", "r1", "source", "original.mp4"];
let root: string;

function context(key: string[]) {
  return { params: Promise.resolve({ key }) };
}

function put(key: string[], body: Uint8Array<ArrayBuffer>) {
  return PUT(new Request("http://x/", { method: "PUT", body }), context(key));
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
      expect((await put(KEY, new Uint8Array([1]))).status).toBe(404);
      expect((await GET(new Request("http://x/"), context(KEY))).status).toBe(404);
      expect((await HEAD(new Request("http://x/"), context(KEY))).status).toBe(404);
    });
  }
});

describe("with E2E_MOCK_STORAGE=true", () => {
  beforeEach(() => {
    vi.stubEnv("E2E_MOCK_STORAGE", "true");
  });

  it("round-trips a PUT through GET and HEAD", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const answer = await put(KEY, body);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("ETag")).toBeTruthy();

    const read = await GET(new Request("http://x/"), context(KEY));
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);

    const head = await HEAD(new Request("http://x/"), context(KEY));
    expect(head.headers.get("Content-Length")).toBe("3");
  });

  it("answers 400 to a key that could leave the folder", async () => {
    expect((await put(["..", "x"], new Uint8Array([1]))).status).toBe(400);
    expect((await put(["a", "..", "..", "x"], new Uint8Array([1]))).status).toBe(400);
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
});
