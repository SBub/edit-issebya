import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, HEAD, POST, PUT } from "./route";

const KEY = ["dev", "reels", "r1", "source", "original.mp4"];
const BASE = "http://x/studio/api/e2e-storage-mock/dev/reels/r1/source/original.mp4";
let root: string;

function context(key: string[]) {
  return { params: Promise.resolve({ key }) };
}

function send(
  handler: typeof PUT,
  method: string,
  query: string,
  body?: BodyInit,
  key: string[] = KEY,
) {
  return handler(new Request(`${BASE}${query}`, { method, body }), context(key));
}

function tag(xml: string, name: string): string | undefined {
  const start = xml.indexOf(`<${name}>`);
  const end = xml.indexOf(`</${name}>`);
  return start < 0 || end < 0 ? undefined : xml.slice(start + name.length + 2, end);
}

// The body Uppy sends to complete: one Part per uploaded part.
function completeBody(parts: { partNumber: number; etag: string }[]): string {
  const listed = parts
    .map(
      ({ partNumber, etag }) =>
        `<Part><PartNumber>${partNumber}</PartNumber><ETag>${etag}</ETag></Part>`,
    )
    .join("");
  return `<CompleteMultipartUpload>${listed}</CompleteMultipartUpload>`;
}

async function createUpload(): Promise<string> {
  const answer = await send(POST, "POST", "?uploads");
  expect(answer.status).toBe(200);
  expect(answer.headers.get("Content-Type")).toBe("application/xml");
  const uploadId = tag(await answer.text(), "UploadId");
  expect(uploadId).toMatch(/^[a-f0-9]{32}$/);
  return uploadId ?? "";
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
    it(`answers 404 to every method and verb (${String(flag)})`, async () => {
      vi.stubEnv("E2E_MOCK_STORAGE", flag);
      const id = "a".repeat(32);
      expect((await send(POST, "POST", "?uploads")).status).toBe(404);
      expect((await send(POST, "POST", `?uploadId=${id}`, "<x/>")).status).toBe(404);
      expect((await send(PUT, "PUT", `?partNumber=1&uploadId=${id}`, "x")).status).toBe(404);
      expect((await send(PUT, "PUT", "", "x")).status).toBe(404);
      expect((await send(GET, "GET", `?uploadId=${id}`)).status).toBe(404);
      expect((await send(GET, "GET", "")).status).toBe(404);
      expect((await send(DELETE, "DELETE", `?uploadId=${id}`)).status).toBe(404);
      expect((await send(HEAD, "HEAD", "")).status).toBe(404);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
      expect(existsSync(join(root, ".e2e-storage"))).toBe(false);
    });
  }
});

describe("with E2E_MOCK_STORAGE=true", () => {
  beforeEach(() => {
    vi.stubEnv("E2E_MOCK_STORAGE", "true");
  });

  it("round-trips create, two parts, list and complete through GET and HEAD", async () => {
    const uploadId = await createUpload();
    const one = await send(PUT, "PUT", `?partNumber=1&uploadId=${uploadId}`, "abc");
    const two = await send(PUT, "PUT", `?partNumber=2&uploadId=${uploadId}`, "de");
    expect(one.status).toBe(200);
    const etags = [one.headers.get("ETag"), two.headers.get("ETag")];
    expect(etags[0]).toMatch(/^"[a-f0-9]{32}"$/);

    const listed = await (await send(GET, "GET", `?uploadId=${uploadId}`)).text();
    expect(listed).toContain("<ListPartsResult>");
    expect(listed).toContain("<IsTruncated>false</IsTruncated>");
    expect(listed.split("<Part>")).toHaveLength(3);
    expect(listed).toContain("<PartNumber>2</PartNumber>");
    expect(listed).toContain("<Size>2</Size>");

    const body = completeBody([
      { partNumber: 1, etag: etags[0] ?? "" },
      // Uppy may send an ETag without its quotes.
      { partNumber: 2, etag: (etags[1] ?? "").replaceAll('"', "") },
    ]);
    const completed = await send(POST, "POST", `?uploadId=${uploadId}`, body);
    expect(completed.status).toBe(200);
    const result = await completed.text();
    expect(tag(result, "Key")).toBe(KEY.join("/"));
    expect(tag(result, "Location")).toBe(BASE);

    const read = await send(GET, "GET", "");
    expect(await read.text()).toBe("abcde");
    expect((await send(HEAD, "HEAD", "")).headers.get("Content-Length")).toBe("5");

    // The upload is gone once complete, as on R2.
    const again = await send(POST, "POST", `?uploadId=${uploadId}`, body);
    expect(again.status).toBe(404);
    expect(await again.text()).toContain("<Code>NoSuchUpload</Code>");
  });

  it("refuses the plain object PUT", async () => {
    expect((await send(PUT, "PUT", "", "abc")).status).toBe(400);
    expect((await send(PUT, "PUT", "?partNumber=1", "abc")).status).toBe(400);
    expect((await send(GET, "GET", "")).status).toBe(404);
  });

  it("refuses a bad or foreign upload id and writes nothing", async () => {
    const uploadId = await createUpload();
    for (const id of ["..%2Fx", uploadId.toUpperCase(), "b".repeat(32)]) {
      const answer = await send(PUT, "PUT", `?partNumber=1&uploadId=${id}`, "x");
      expect(answer.status).toBe(404);
      expect(await answer.text()).toContain("<Code>NoSuchUpload</Code>");
    }
    const other = ["dev", "reels", "r2", "source", "original.mp4"];
    expect((await send(PUT, "PUT", `?partNumber=1&uploadId=${uploadId}`, "x", other)).status).toBe(
      404,
    );
    expect(await (await send(GET, "GET", `?uploadId=${uploadId}`)).text()).not.toContain("<Part>");
  });

  it("refuses a wrong ETag on complete", async () => {
    const uploadId = await createUpload();
    await send(PUT, "PUT", `?partNumber=1&uploadId=${uploadId}`, "abc");
    const answer = await send(
      POST,
      "POST",
      `?uploadId=${uploadId}`,
      completeBody([{ partNumber: 1, etag: "0" }]),
    );
    expect(answer.status).toBe(400);
    expect(await answer.text()).toContain("<Code>InvalidPart</Code>");
  });

  it("aborts, removing the parts", async () => {
    const uploadId = await createUpload();
    await send(PUT, "PUT", `?partNumber=1&uploadId=${uploadId}`, "abc");
    expect((await send(DELETE, "DELETE", `?uploadId=${uploadId}`)).status).toBe(204);
    expect((await send(DELETE, "DELETE", `?uploadId=${uploadId}`)).status).toBe(204);
    expect((await send(GET, "GET", `?uploadId=${uploadId}`)).status).toBe(404);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(await readdir(join(root, ".e2e-storage", ".multipart"))).toEqual([]);
  });

  it("answers 400 to a key that could leave the folder", async () => {
    expect((await send(POST, "POST", "?uploads", undefined, ["..", "x"])).status).toBe(400);
    expect((await send(GET, "GET", "", undefined, ["a", "..", "..", "x"])).status).toBe(400);
  });
});
