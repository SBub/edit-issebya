import { describe, expect, it } from "vitest";
import { canRetry, isRetried, waitingForAiLine } from "./job-failures";

describe("waitingForAiLine", () => {
  const waiting = { waiting_reason: "usage limit reached", not_before: "2026-11-02T14:05:00Z" };

  it("says why and when the next try is, in 24 hours in the given zone", () => {
    expect(waitingForAiLine(waiting, "UTC")).toBe(
      "Waiting for the AI: usage limit reached. Next try at 14:05.",
    );
    expect(waitingForAiLine(waiting, "Europe/Berlin")).toBe(
      "Waiting for the AI: usage limit reached. Next try at 15:05.",
    );
    expect(waitingForAiLine({ ...waiting, not_before: "2026-11-02T23:30:00Z" }, "UTC")).toBe(
      "Waiting for the AI: usage limit reached. Next try at 23:30.",
    );
  });

  it("is null for a job that is not waiting", () => {
    expect(waitingForAiLine({ waiting_reason: null, not_before: null }, "UTC")).toBeNull();
  });
});

describe("canRetry", () => {
  const failed = { id: "j1", status: "failed" as const };
  const processed = { status: "processed" as const };

  it("offers a failed job once", () => {
    expect(canRetry(failed, [{ retry_of_job_id: null }], processed)).toBe(true);
    expect(canRetry(failed, [{ retry_of_job_id: "j1" }], processed)).toBe(false);
    expect(isRetried(failed, [{ retry_of_job_id: "j1" }])).toBe(true);
    expect(isRetried(failed, [{ retry_of_job_id: "j9" }])).toBe(false);
  });

  it("never offers a job that did not fail, or one on a refused reel", () => {
    for (const status of ["queued", "running", "waiting_ai", "done"] as const) {
      expect(canRetry({ id: "j1", status }, [], processed)).toBe(false);
    }
    expect(canRetry(failed, [], { status: "refused" })).toBe(false);
    expect(canRetry(failed, [], { status: "failed" })).toBe(true);
  });
});
