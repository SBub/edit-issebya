import { describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { recordPreviewCopies } from "./record-preview-copies.ts";

const FP = "a".repeat(64);

describe("recordPreviewCopies", () => {
  it("writes the preview_copies fingerprint on the job's reel", async () => {
    const { steps, calls } = recordingSteps();
    await recordPreviewCopies(stepContext(steps), { retime: "b".repeat(64), preview_copies: FP });
    expect(calls).toEqual([{ call: "previewCopies", reelId: TEST_JOB.reel_id, fingerprint: FP }]);
  });

  it("writes nothing after a lost lease", async () => {
    const { steps, calls } = recordingSteps();
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));
    await expect(
      recordPreviewCopies(stepContext(steps, { signal: controller.signal }), {
        preview_copies: FP,
      }),
    ).rejects.toThrow("lease lost");
    expect(calls).toEqual([]);
  });

  it("refuses fingerprints without preview_copies", async () => {
    const { steps, calls } = recordingSteps();
    await expect(recordPreviewCopies(stepContext(steps), {})).rejects.toThrow("preview_copies");
    expect(calls).toEqual([]);
  });
});
