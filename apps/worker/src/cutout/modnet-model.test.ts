import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MATTE_SETTINGS } from "./matte.ts";
import { MODNET_MODEL, modnetModelPath, verifyModel } from "./modnet-model.ts";

const BYTES = new TextEncoder().encode("a tiny model");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "modnet-model-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the model's place", () => {
  it("is the committed file under apps/worker/models", () => {
    expect(modnetModelPath()).toMatch(/apps\/worker\/models\/modnet_int8_13\.onnx$/);
  });

  it("is pinned to the int8 file by name, size and SHA-256, the hash every mask names", () => {
    expect(MODNET_MODEL).toEqual({
      file: "modnet_int8_13.onnx",
      sha256: "a293b5ae8fb8ac81447a82bf1ad661479fb412fe2d276188711386c6c81df28b",
      bytes: 6_912_985,
    });
    expect(MATTE_SETTINGS.modelSha256).toBe(MODNET_MODEL.sha256);
  });

  it("ships the pinned file", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    const file = await readFile(modnetModelPath());
    expect(file.byteLength).toBe(MODNET_MODEL.bytes);
    expect(createHash("sha256").update(file).digest("hex")).toBe(MODNET_MODEL.sha256);
    await expect(verifyModel(modnetModelPath())).resolves.toBeUndefined();
  });

  it("ships the model's notice beside it: the attribution and the Apache 2.0 text", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own notice
    const notice = await readFile(
      new URL("../../models/THIRD_PARTY_NOTICES.md", import.meta.url),
      "utf8",
    );
    expect(notice).toContain("https://github.com/ZHKKKe/MODNet");
    expect(notice).toContain("07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9");
    expect(notice).toContain("Copyright (c) Microsoft Corporation");
    expect(notice).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(notice).toContain("END OF TERMS AND CONDITIONS");
  });
});

describe("verifyModel", () => {
  it("names a missing model and how to restore it", async () => {
    const path = join(dir, "none.onnx");
    await expect(verifyModel(path)).rejects.toThrow(
      `MODNet model missing at ${path}, restore it with git checkout -- apps/worker/models/modnet_int8_13.onnx`,
    );
  });

  it("refuses a file with another size or hash", async () => {
    const path = join(dir, "other.onnx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    await writeFile(path, BYTES);
    const sha = createHash("sha256").update(BYTES).digest("hex");
    await expect(verifyModel(path)).rejects.toThrow(
      `has 12 bytes and SHA-256 ${sha.slice(0, 8)}, not 6912985 bytes and a293b5ae`,
    );
  });
});
