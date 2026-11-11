import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { U2NET_MODEL, u2netModelPath, verifyU2netModel } from "./u2net-model.ts";

const BYTES = new TextEncoder().encode("a tiny model");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "u2net-model-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the model's place", () => {
  it("is the committed file under apps/worker/models", () => {
    expect(u2netModelPath()).toMatch(/apps\/worker\/models\/u2net_int8_static13\.onnx$/);
  });

  it("is pinned to the int8 file by name, size and SHA-256", () => {
    expect(U2NET_MODEL).toEqual({
      file: "u2net_int8_static13.onnx",
      sha256: "a42be65f30af575480020f4d827eabadf73c8cdfd8f77577d2946780f54dc746",
      bytes: 44_444_038,
    });
  });

  it("ships the pinned file", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    const file = await readFile(u2netModelPath());
    expect(file.byteLength).toBe(U2NET_MODEL.bytes);
    expect(createHash("sha256").update(file).digest("hex")).toBe(U2NET_MODEL.sha256);
    await expect(verifyU2netModel(u2netModelPath())).resolves.toBeUndefined();
  });

  it("ships the model's notice beside it: the attribution, the changes and the Apache 2.0 text", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own notice
    const notice = await readFile(
      new URL("../../models/THIRD_PARTY_NOTICES.md", import.meta.url),
      "utf8",
    );
    expect(notice).toContain("## u2net_int8_static13.onnx");
    expect(notice).toContain("https://github.com/xuebinqin/U-2-Net");
    expect(notice).toContain("01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c");
    expect(notice).toContain("opset 13");
    expect(notice).toContain("statically quantised to int8");
    expect(notice).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
  });
});

describe("verifyU2netModel", () => {
  it("names a missing model and how to restore it", async () => {
    const path = join(dir, "none.onnx");
    await expect(verifyU2netModel(path)).rejects.toThrow(
      `U2Net model missing at ${path}, restore it with git checkout -- apps/worker/models/u2net_int8_static13.onnx`,
    );
  });

  it("refuses a file with another size or hash", async () => {
    const path = join(dir, "other.onnx");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    await writeFile(path, BYTES);
    const sha = createHash("sha256").update(BYTES).digest("hex");
    await expect(verifyU2netModel(path)).rejects.toThrow(
      `has 12 bytes and SHA-256 ${sha.slice(0, 8)}, not 44444038 bytes and a42be65f`,
    );
  });
});
