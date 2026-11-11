import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modnetModelPath } from "./cutout/modnet-model.ts";
import { u2netModelPath } from "./pipeline/u2net-model.ts";

// The worker image (apps/worker/Dockerfile) carries the MODNet and U2Net
// models as part of the worker's folder: no download stage, no model folder of
// its own.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own Dockerfile
const DOCKERFILE = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the repository's own file
const DOCKERIGNORE = readFileSync(new URL("../../../.dockerignore", import.meta.url), "utf8");

describe("worker Dockerfile", () => {
  it("copies the worker's folder, the committed models in it, and downloads no model", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    expect(existsSync(modnetModelPath())).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    expect(existsSync(u2netModelPath())).toBe(true);
    expect(DOCKERFILE).toContain("\nCOPY apps/worker apps/worker\n");
    expect(DOCKERFILE).not.toMatch(/MODNET_URL|WORKER_MODELS_DIR|AS modnet/);
    expect(DOCKERIGNORE).not.toMatch(/apps\/worker\/models|\.onnx/);
  });
});
