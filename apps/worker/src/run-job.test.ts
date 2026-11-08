import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob, JobFailure } from "./queue.ts";
import { AiUnavailable, AnswerRefused, FootageRefused, TransientError } from "./failure.ts";
import { runJob } from "./run-job.ts";
import { recordingSteps, stepContext } from "./recording-steps.ts";
import { StepError, runInProcessStep } from "./step-runner.ts";

const JOB: ClaimedJob = {
  id: "j1",
  reel_id: "r1",
  photo_id: null,
  owner_id: "o1",
  kind: "process",
  attempts: 1,
  restore_version_id: null,
  version_id: null,
};

function deps(
  work: (
    signal: AbortSignal,
    checkCancelled: () => Promise<boolean>,
    checkGone: () => Promise<boolean>,
  ) => Promise<void>,
) {
  return {
    job: JOB,
    renewEveryMs: 60_000,
    renew: vi.fn(async () => true),
    work,
    finish: vi.fn(async () => true),
    fail: vi.fn(async (tail: string, failure: JobFailure) => tail.length > 0 && failure !== null),
    refuse: vi.fn(async (message: string) => message.length > 0),
    wait: vi.fn(async (reason: string) => reason.length > 0),
    errors: { jobFailed: vi.fn() },
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

  it("passes the failure kind to fail and captures a failure outside any step", async () => {
    const d = deps(async () => {
      throw new TransientError("fetch failed");
    });
    expect(await runJob(d)).toBe("failed");
    expect(d.fail.mock.calls[0]?.[1]).toEqual({ kind: "transient", rules: null });
    expect(d.errors.jobFailed).toHaveBeenCalledOnce();
    expect(d.errors.jobFailed.mock.calls[0]?.[0]).toMatchObject({
      job: JOB,
      failure: { kind: "transient", rules: null },
    });
  });

  it("passes a refused answer's rules and keeps the log line", async () => {
    const lines: string[] = [];
    const d = {
      ...deps(async () => {
        throw new StepError("decide: the answer failed twice", "tail", undefined, {
          cause: new AnswerRefused(["behind-caption", "safe-box"], 2),
        });
      }),
      log: (line: string) => lines.push(line),
    };
    expect(await runJob(d)).toBe("failed");
    expect(d.fail.mock.calls[0]?.[1]).toEqual({
      kind: "answer_refused",
      rules: ["behind-caption", "safe-box"],
    });
    expect(lines).toEqual(["job j1: failed: StepError: decide: the answer failed twice"]);
  });

  it("never captures a job failure for an error a step already captured", async () => {
    const { steps } = recordingSteps();
    const d = deps(async (signal) => {
      await runInProcessStep(stepContext(steps, { signal, job: JOB }), {
        name: "convert",
        work: async () => {
          throw new Error("no such file");
        },
      });
    });
    expect(await runJob(d)).toBe("failed");
    expect(d.fail.mock.calls[0]?.[1]).toEqual({ kind: "failed", rules: null });
    expect(d.errors.jobFailed).not.toHaveBeenCalled();
  });

  it("logs and stores a failed tool's stderr, not only its first line", async () => {
    const lines: string[] = [];
    const d = {
      ...deps(async () => {
        const error = new Error(
          "photo_images exited with 1\nFailed to set value '/p/a.jpg' for option 'show_stream_groups': Option not found",
        );
        throw error;
      }),
      log: (line: string) => lines.push(line),
    };
    expect(await runJob(d)).toBe("failed");
    expect(lines.join("\n")).toContain(
      "failed: Error: photo_images exited with 1\nFailed to set value",
    );
    expect(d.fail.mock.calls[0]?.[0]).toContain("Option not found");
    expect(d.fail.mock.calls[0]?.[0]).not.toContain("    at ");
  });

  it("refuses the reel when the footage is refused, deep in the cause chain", async () => {
    const d = deps(async () => {
      throw new Error("check_footage failed", {
        cause: new FootageRefused("This clip has no sound."),
      });
    });
    expect(await runJob(d)).toBe("refused");
    expect(d.refuse).toHaveBeenCalledWith("This clip has no sound.");
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.wait).not.toHaveBeenCalled();
  });

  it("makes the job wait when the AI is not available", async () => {
    const d = deps(async () => {
      throw new Error("decide failed", { cause: new AiUnavailable("the usage limit is reached") });
    });
    expect(await runJob(d)).toBe("waiting");
    expect(d.wait).toHaveBeenCalledWith("the usage limit is reached");
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("is lost when the guarded refuse or wait matched no row", async () => {
    const refused = deps(async () => {
      throw new FootageRefused("This file is not a video.");
    });
    refused.refuse.mockResolvedValue(false);
    expect(await runJob(refused)).toBe("lost");
    const waiting = deps(async () => {
      throw new AiUnavailable("Claude Code is signed out");
    });
    waiting.wait.mockResolvedValue(false);
    expect(await runJob(waiting)).toBe("lost");
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

  it("is cancelled and writes nothing once the owner cancels the job", async () => {
    const d = {
      ...deps(async (signal, checkCancelled) => {
        expect(await checkCancelled()).toBe(true);
        signal.throwIfAborted();
      }),
      cancelled: vi.fn(async () => true),
      cancelCheckEveryMs: 60_000,
    };
    expect(await runJob(d)).toBe("cancelled");
    expect(d.finish).not.toHaveBeenCalled();
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.refuse).not.toHaveBeenCalled();
    expect(d.wait).not.toHaveBeenCalled();
    expect(d.errors.jobFailed).not.toHaveBeenCalled();
  });

  it("is cancelled when a cancel lands after the work returned", async () => {
    const d = {
      ...deps(async (_signal, checkCancelled) => {
        await checkCancelled();
      }),
      cancelled: vi.fn(async () => true),
    };
    expect(await runJob(d)).toBe("cancelled");
    expect(d.finish).not.toHaveBeenCalled();
  });

  describe("a job whose row is gone (its reel deleted)", () => {
    function goneDeps(work: Parameters<typeof deps>[0]) {
      const lines: string[] = [];
      const d = {
        ...deps(work),
        gone: vi.fn(async () => true),
        log: (line: string) => void lines.push(line),
      };
      return { d, lines };
    }

    function expectNothingWritten(d: ReturnType<typeof goneDeps>["d"], lines: string[]) {
      expect(d.finish).not.toHaveBeenCalled();
      expect(d.fail).not.toHaveBeenCalled();
      expect(d.refuse).not.toHaveBeenCalled();
      expect(d.wait).not.toHaveBeenCalled();
      expect(d.errors.jobFailed).not.toHaveBeenCalled();
      expect(lines).toEqual(["job j1: reel deleted, stopped"]);
    }

    it("is deleted when a renewal finds the row gone", async () => {
      vi.useFakeTimers();
      try {
        const { d, lines } = goneDeps(async (signal) => {
          await vi.advanceTimersByTimeAsync(60_000);
          signal.throwIfAborted();
        });
        d.renew.mockResolvedValue(false);
        expect(await runJob(d)).toBe("deleted");
        expectNothingWritten(d, lines);
      } finally {
        vi.useRealTimers();
      }
    });

    it("is deleted when the work throws (a refused write) and the row is gone", async () => {
      const { d, lines } = goneDeps(async () => {
        throw new Error('insert violates foreign key constraint "steps_reel_id_fkey"');
      });
      expect(await runJob(d)).toBe("deleted");
      expectNothingWritten(d, lines);
    });

    it("is deleted, never refused or waiting, for a refusal or an unavailable AI", async () => {
      for (const error of [new FootageRefused("not vertical"), new AiUnavailable("limit")]) {
        const { d, lines } = goneDeps(async () => {
          throw error;
        });
        expect(await runJob(d)).toBe("deleted");
        expectNothingWritten(d, lines);
      }
    });

    it("is deleted when finish matched no row and the row is gone", async () => {
      const lines: string[] = [];
      let deleted = false;
      const d = {
        ...deps(async () => {}),
        gone: vi.fn(async () => deleted),
        log: (line: string) => void lines.push(line),
      };
      d.finish.mockImplementation(async () => {
        deleted = true;
        return false;
      });
      expect(await runJob(d)).toBe("deleted");
      expect(d.fail).not.toHaveBeenCalled();
      expect(lines).toEqual(["job j1: reel deleted, stopped"]);
    });

    it("is deleted when a failure's write matched no row and the row is gone by then", async () => {
      let deleted = false;
      const lines: string[] = [];
      const d = {
        ...deps(async () => {
          throw new Error("boom");
        }),
        gone: vi.fn(async () => deleted),
        log: (line: string) => void lines.push(line),
      };
      d.fail.mockImplementation(async () => {
        deleted = true;
        return false;
      });
      expect(await runJob(d)).toBe("deleted");
      expect(lines.filter((line) => line.includes("lease lost"))).toEqual([]);
      expect(lines.at(-1)).toBe("job j1: reel deleted, stopped");
    });

    it("says photo for a describe_photo job", async () => {
      const { d, lines } = goneDeps(async () => {
        throw new Error("gone");
      });
      const photoJob = {
        ...d,
        job: { ...JOB, reel_id: null, photo_id: "p1", kind: "describe_photo" },
      };
      expect(await runJob(photoJob)).toBe("deleted");
      expect(lines).toEqual(["job j1: photo deleted, stopped"]);
    });

    it("stays failed when the row is still there", async () => {
      const d = {
        ...deps(async () => {
          throw new Error("boom");
        }),
        gone: vi.fn(async () => false),
      };
      expect(await runJob(d)).toBe("failed");
      expect(d.fail).toHaveBeenCalledOnce();
    });
  });
});
