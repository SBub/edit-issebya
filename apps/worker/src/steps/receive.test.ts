import type { Storage } from "@edit-issebya/storage";
import { describe, expect, it } from "vitest";
import type { ClaimedJob } from "../queue.ts";
import { type StepStore, receive } from "./receive.ts";

const JOB: ClaimedJob = { id: "j1", reel_id: "r1", owner_id: "o1", kind: "process", attempts: 1 };
const KEY = "dev/reels/r1/source/original.mp4";

function recordingSteps(sourceKey: string | null = KEY) {
  const calls: unknown[][] = [];
  const steps: StepStore = {
    async start(job, name) {
      calls.push(["start", job.id, name]);
      return "s1";
    },
    async sourceKey() {
      return sourceKey;
    },
    async done(id, summary) {
      calls.push(["done", id, summary]);
    },
    async failed(id, tail) {
      calls.push(["failed", id, tail.split("\n")[0]]);
    },
  };
  return { steps, calls };
}

function storageWith(
  head: (key: string, signal?: AbortSignal) => Promise<{ bytes: number } | null>,
) {
  return {
    head: (key: string, options?: { signal?: AbortSignal }) => head(key, options?.signal),
  } as unknown as Storage;
}

describe("receive", () => {
  it("records the size of the source object", async () => {
    const { steps, calls } = recordingSteps();
    const storage = storageWith(async (key) => (key === KEY ? { bytes: 12_897_485 } : null));
    await receive({ steps, storage, job: JOB, signal: new AbortController().signal });
    expect(calls).toEqual([
      ["start", "j1", "receive"],
      ["done", "s1", "footage received, 12.3 MB"],
    ]);
  });

  it("fails the step when the object is missing", async () => {
    const { steps, calls } = recordingSteps();
    const storage = storageWith(async () => null);
    await expect(
      receive({ steps, storage, job: JOB, signal: new AbortController().signal }),
    ).rejects.toThrow("source object missing");
    expect(calls).toEqual([
      ["start", "j1", "receive"],
      ["failed", "s1", "Error: source object missing"],
    ]);
  });

  it("writes nothing more after an abort", async () => {
    const { steps, calls } = recordingSteps();
    const controller = new AbortController();
    const storage = storageWith(async () => {
      controller.abort(new Error("lease lost"));
      return { bytes: 10 };
    });
    await expect(receive({ steps, storage, job: JOB, signal: controller.signal })).rejects.toThrow(
      "lease lost",
    );
    expect(calls).toEqual([["start", "j1", "receive"]]);
  });
});
