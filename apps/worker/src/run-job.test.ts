import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "./queue.ts";
import { runJob } from "./run-job.ts";

const JOB: ClaimedJob = {
  id: "j1",
  reel_id: "r1",
  owner_id: "o1",
  kind: "process",
  attempts: 1,
  request: null,
  restore_version_id: null,
  version_id: null,
};

function deps(work: (signal: AbortSignal) => Promise<void>) {
  return {
    job: JOB,
    renewEveryMs: 60_000,
    renew: vi.fn(async () => true),
    work,
    finish: vi.fn(async () => true),
    fail: vi.fn(async (tail: string) => tail.length > 0),
    log: () => {},
  };
}

describe("runJob", () => {
  it("finishes the job on success", async () => {
    const d = deps(async () => {});
    expect(await runJob(d)).toBe("done");
    expect(d.finish).toHaveBeenCalledOnce();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("fails the job with the error's tail", async () => {
    const d = deps(async () => {
      throw new Error("source object missing");
    });
    expect(await runJob(d)).toBe("failed");
    expect(d.finish).not.toHaveBeenCalled();
    expect(d.fail.mock.calls[0]?.[0]).toContain("source object missing");
  });

  it("writes neither after a lost lease", async () => {
    vi.useFakeTimers();
    try {
      const d = deps(async (signal) => {
        await vi.advanceTimersByTimeAsync(60_000);
        signal.throwIfAborted();
      });
      d.renew.mockResolvedValue(false);
      expect(await runJob(d)).toBe("lost");
      expect(d.finish).not.toHaveBeenCalled();
      expect(d.fail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
