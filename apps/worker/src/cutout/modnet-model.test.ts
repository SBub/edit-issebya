import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODNET_MODEL,
  installModel,
  modelsDirOf,
  modnetModelPath,
  verifyModel,
} from "./modnet-model.ts";

// A tiny stand-in for the model: never the network, never the real file.
const BYTES = new TextEncoder().encode("a tiny model");
const FAKE = {
  ...MODNET_MODEL,
  url: "https://models.test/modnet.onnx",
  sha256: createHash("sha256").update(BYTES).digest("hex"),
  bytes: BYTES.byteLength,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "modnet-model-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function serving(body: Uint8Array, status = 200) {
  const urls: string[] = [];
  const get = async (url: string) => {
    urls.push(url);
    return new Response(body, { status });
  };
  return { get, urls };
}

describe("the model's place", () => {
  it("is WORKER_MODELS_DIR, else ~/.edit-issebya-worker/models", () => {
    expect(modnetModelPath({ WORKER_MODELS_DIR: "/m" })).toBe(
      "/m/modnet_photographic_portrait_matting.onnx",
    );
    expect(modelsDirOf({})).toMatch(/\.edit-issebya-worker\/models$/);
  });

  it("is pinned to the official ONNX by size and SHA-256", () => {
    expect(MODNET_MODEL).toMatchObject({
      sha256: "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9",
      bytes: 25_888_640,
    });
    // eslint-disable-next-line no-secrets/no-secrets -- a public Google Drive file id, not a key
    expect(MODNET_MODEL.url).toContain("1cgycTQlYXpTh26gB9FTnthE7AvruV8hd");
  });
});

describe("verifyModel", () => {
  it("names a missing model and how to install it", async () => {
    const path = join(dir, "none.onnx");
    await expect(verifyModel(path)).rejects.toThrow(
      `MODNet model not installed at ${path}, run yarn workspace @edit-issebya/worker models:install`,
    );
  });

  it("refuses a file with another hash", async () => {
    const path = join(dir, "other.onnx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    await writeFile(path, BYTES);
    await expect(verifyModel(path)).rejects.toThrow(
      `has SHA-256 ${FAKE.sha256.slice(0, 8)}, not 07c308cf`,
    );
  });
});

describe("installModel", () => {
  it("downloads, checks and renames the model, then keeps it", async () => {
    const path = join(dir, "models", "modnet.onnx");
    const { get, urls } = serving(BYTES);
    expect(await installModel(path, { fetch: get, model: FAKE })).toBe("installed");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
    expect(await installModel(path, { fetch: get, model: FAKE })).toBe("present");
    expect(urls).toEqual([FAKE.url]);
  });

  it("refuses a download with another hash and leaves nothing behind", async () => {
    const path = join(dir, "modnet.onnx");
    const { get } = serving(new TextEncoder().encode("a tiny modem"));
    await expect(installModel(path, { fetch: get, model: FAKE })).rejects.toThrow(
      /model download refused: 12 bytes with SHA-256 [0-9a-f]{64}, expected 12 bytes/,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails on an HTTP error", async () => {
    const { get } = serving(new Uint8Array(), 404);
    await expect(
      installModel(join(dir, "modnet.onnx"), { fetch: get, model: FAKE }),
    ).rejects.toThrow("model download failed: HTTP 404 from https://models.test/modnet.onnx");
  });
});
