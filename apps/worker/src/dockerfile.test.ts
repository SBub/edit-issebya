import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modnetModelPath } from "./cutout/modnet-model.ts";
import { ALIGN_MODEL } from "./pipeline/align-model.ts";
import { u2netModelPath } from "./pipeline/u2net-model.ts";

// The worker image (apps/worker/Dockerfile) carries the MODNet and U2Net
// models as part of the worker's folder (committed, no download stage), and
// the word aligner's published model fetched by a stage of its own at its pin.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own Dockerfile
const DOCKERFILE = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the repository's own file
const DOCKERIGNORE = readFileSync(new URL("../../../.dockerignore", import.meta.url), "utf8");

describe("worker Dockerfile", () => {
  it("copies the worker's folder and the committed models in it, never downloading them", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    expect(existsSync(modnetModelPath())).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    expect(existsSync(u2netModelPath())).toBe(true);
    expect(DOCKERFILE).toContain("\nCOPY apps/worker apps/worker\n");
    expect(DOCKERFILE).not.toMatch(/MODNET_URL|WORKER_MODELS_DIR|AS modnet/);
    expect(DOCKERIGNORE).not.toMatch(/modnet|u2net/);
  });

  it("fetches the aligner's model at its pinned URL and hash, and copies it beside them", () => {
    const [, revision] = /resolve\/([0-9a-f]{40})\//.exec(ALIGN_MODEL.url!)!;
    expect(DOCKERFILE).toContain(`ARG ALIGN_MODEL_REVISION=${revision}`);
    expect(DOCKERFILE).toContain(
      `${ALIGN_MODEL.url!.replace(revision!, "${ALIGN_MODEL_REVISION}")}`,
    );
    expect(DOCKERFILE).toContain(`${ALIGN_MODEL.sha256}  /${ALIGN_MODEL.file}`);
    expect(DOCKERFILE).toContain(
      `COPY --from=aligner /${ALIGN_MODEL.file} apps/worker/models/${ALIGN_MODEL.file}`,
    );
    expect(DOCKERIGNORE).toContain(`apps/worker/models/${ALIGN_MODEL.file}`);
  });
});
