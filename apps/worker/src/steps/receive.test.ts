import type { Storage } from "@edit-issebya/storage";
import { describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { receive } from "./receive.ts";

const KEY = `dev/reels/${TEST_JOB.reel_id}/source/original.mp4`;
const IN_PROCESS = { cpu_ms: null, peak_rss_bytes: null, bytes_in: null, bytes_out: null };

function storageWith(
  head: (key: string, signal?: AbortSignal) => Promise<{ bytes: number } | null>,
) {
  return {
    head: (key: string, options?: { signal?: AbortSignal }) => head(key, options?.signal),
  } as unknown as Storage;
}

describe("receive", () => {
  it("records the size of the source object, measured by wall time only", async () => {
    const { steps, calls } = recordingSteps(KEY);
    const storage = storageWith(async (key) => (key === KEY ? { bytes: 12_897_485 } : null));
    await receive({ ...stepContext(steps), storage });
    expect(calls).toEqual([
      { call: "start", jobId: TEST_JOB.id, name: "receive" },
      {
        call: "done",
        stepId: "s1",
        summary: "footage received, under a second, 12.3 MB",
        measurements: { wall_ms: expect.any(Number), ...IN_PROCESS },
      },
    ]);
  });

  it("fails the step when the object is missing", async () => {
    const { steps, calls } = recordingSteps(KEY);
    const storage = storageWith(async () => null);
    await expect(receive({ ...stepContext(steps), storage })).rejects.toThrow(
      "source object missing",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      call: "failed",
      stepId: "s1",
      summary: "receive failed, under a second",
      measurements: { wall_ms: expect.any(Number), ...IN_PROCESS },
    });
    expect(calls[1]?.call === "failed" && calls[1].tail.split("\n")[0]).toBe(
      "Error: source object missing",
    );
  });

  it("writes nothing more after an abort", async () => {
    const { steps, calls } = recordingSteps(KEY);
    const controller = new AbortController();
    const storage = storageWith(async () => {
      controller.abort(new Error("lease lost"));
      return { bytes: 10 };
    });
    await expect(
      receive({ ...stepContext(steps, { signal: controller.signal }), storage }),
    ).rejects.toThrow("lease lost");
    expect(calls).toEqual([{ call: "start", jobId: TEST_JOB.id, name: "receive" }]);
  });
});
