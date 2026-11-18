import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALIGN_MODEL,
  ALIGN_MODEL_REVISION,
  alignModelPath,
  verifyAlignModel,
} from "./align-model.ts";

describe("the aligner's model", () => {
  it("lives in apps/worker/models, fetched, not committed", () => {
    expect(alignModelPath()).toMatch(/apps\/worker\/models\/wav2vec2-base-960h\.onnx$/);
  });

  it("is pinned to the float32 export by name, size, SHA-256 and revision", () => {
    expect(ALIGN_MODEL).toEqual({
      file: "wav2vec2-base-960h.onnx",
      sha256: "e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d",
      bytes: 377_887_594,
      url: `https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/${ALIGN_MODEL_REVISION}/onnx/model.onnx`,
    });
    expect(ALIGN_MODEL_REVISION).toBe("a19f851b3d42865797e410752b4c570c871e4825");
  });

  it("has its notice beside the worker's other models", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own notice
    const notice = await readFile(
      new URL("../../models/THIRD_PARTY_NOTICES.md", import.meta.url),
      "utf8",
    );
    expect(notice).toContain("## wav2vec2-base-960h.onnx");
    expect(notice).toContain("https://huggingface.co/facebook/wav2vec2-base-960h");
    expect(notice).toContain(ALIGN_MODEL.sha256);
    expect(notice).toContain("used unchanged");
  });

  it("names a missing model and the command that fetches it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "align-model-"));
    try {
      const path = join(dir, "none.onnx");
      await expect(verifyAlignModel(path)).rejects.toThrow(
        `wav2vec2 model missing at ${path}, restore it with yarn workspace @edit-issebya/worker models:fetch`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
