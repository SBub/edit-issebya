import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "./queue.ts";
import { runJob } from "./run-job.ts";
import { AiUnavailableError, FootageRefusedError } from "./failures.ts";

const JOB: ClaimedJob = {
  id: "j1",
  reel_id: "r1",
  owner_id: "o1",
  kind: "process",
  attempts: 1,
  request: null,
  restore_version_id: null,
  version_id: null,
  retry_of_job_id: null,
  waiting_reason: null,
  not_before: null,
};

function deps(work: (signal: AbortSignal) => Promise<void>) {
  return {
    job: JOB,
    renewEveryMs: 60_000,
    renew: vi.fn(async () => true),
    work,
    finish: vi.fn(async () => true),
    fail: vi.fn(async (tail: string) => tail.length > 0),
    refuse: vi.fn(async (message: string) => message.length > 0),
    wait: vi.fn(async (reason: string) => reason.length > 0),
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

  it("refuses the reel with the message of a footage refusal", async () => {
    const message = "This clip is landscape (1920 x 1080); the studio takes vertical footage only.";
    const d = deps(async () => {
      throw new Error("check_footage failed", { cause: new FootageRefusedError(message) });
    });
    expect(await runJob(d)).toBe("refused");
    expect(d.refuse).toHaveBeenCalledExactlyOnceWith(message);
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.wait).not.toHaveBeenCalled();
  });

  it("makes the job wait when the AI is unavailable", async () => {
    const d = deps(async () => {
      throw new Error("decide failed", { cause: new AiUnavailableError("usage limit reached") });
    });
    expect(await runJob(d)).toBe("waiting");
    expect(d.wait).toHaveBeenCalledExactlyOnceWith("usage limit reached");
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.refuse).not.toHaveBeenCalled();
  });

  it("fails a plain error once, neither refusing nor waiting", async () => {
    const d = deps(async () => {
      throw new Error("tool exited with 1");
    });
    expect(await runJob(d)).toBe("failed");
    expect(d.fail).toHaveBeenCalledOnce();
    expect(d.refuse).not.toHaveBeenCalled();
    expect(d.wait).not.toHaveBeenCalled();
  });

  it("is lost when the wait cannot be written under the lease", async () => {
    const d = deps(async () => {
      throw new AiUnavailableError("usage limit reached");
    });
    d.wait.mockResolvedValue(false);
    expect(await runJob(d)).toBe("lost");
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
