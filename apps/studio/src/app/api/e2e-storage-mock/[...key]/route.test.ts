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

  it("serves a GET with a valid download name as an attachment", async () => {
    await put(KEY, new Uint8Array([1, 2, 3]));
    const named = await GET(new Request("http://x/?download=reel-1.mp4"), context(KEY));
    expect(named.headers.get("Content-Disposition")).toBe('attachment; filename="reel-1.mp4"');
    const plain = await GET(new Request("http://x/"), context(KEY));
    expect(plain.headers.get("Content-Disposition")).toBeNull();
    const refused = await GET(
      new Request(`http://x/?download=${encodeURIComponent('a"; x=.mp4')}`),
      context(KEY),
    );
    expect(refused.headers.get("Content-Disposition")).toBeNull();
  });

  it("answers 400 to a key that could leave the folder", async () => {
    expect((await put(["..", "x"], new Uint8Array([1]))).status).toBe(400);
    expect((await put(["a", "..", "..", "x"], new Uint8Array([1]))).status).toBe(400);
  });

  it("answers 404 for a missing object", async () => {
    expect((await GET(new Request("http://x/"), context(["missing.mp4"]))).status).toBe(404);
  });
});
