import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODNET_MODEL } from "./cutout/modnet-model.ts";

// The worker image (apps/worker/Dockerfile) bakes in the MODNet model with its
// own copy of the pin: it must stay the one models:install downloads and
// verifyModel accepts.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own Dockerfile
const DOCKERFILE = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const MODELS_DIR = ["", "opt", "edit-issebya", "models"].join("/");

// The value of `ARG <name>=<value>` (quotes taken off), one per line.
function arg(name: string): string | undefined {
  const line = DOCKERFILE.split("\n").find((l) => l.startsWith(`ARG ${name}=`));
  return line?.slice(`ARG ${name}=`.length).replace(/^"(.*)"$/, "$1");
}

describe("worker Dockerfile", () => {
  it("pins the same MODNet model as modnet-model.ts", () => {
    expect(arg("MODNET_URL")).toBe(MODNET_MODEL.url);
    expect(arg("MODNET_SHA256")).toBe(MODNET_MODEL.sha256);
    expect(arg("MODNET_BYTES")).toBe(String(MODNET_MODEL.bytes));
  });

  it("puts the model under the folder and file name the worker reads", () => {
    expect(DOCKERFILE).toContain(`ENV WORKER_MODELS_DIR=${MODELS_DIR}\n`);
    expect(DOCKERFILE).toContain(`${MODELS_DIR}/${MODNET_MODEL.file}\n`);
  });
});
