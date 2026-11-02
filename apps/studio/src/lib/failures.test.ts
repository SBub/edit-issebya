import { describe, expect, it } from "vitest";
import { changeQueueNote, formatWaitingForAi, retryableJobIds } from "./failures";
import type { JobRow } from "./jobs";

describe("formatWaitingForAi", () => {
  it("names the reason and the next try in 24-hour local time, zero padded", () => {
    const at = new Date(2026, 10, 2, 7, 5).toISOString();
    expect(formatWaitingForAi("the usage limit is reached", at)).toBe(
      "Waiting for the AI: the usage limit is reached. Next try at 07:05.",
    );
    const evening = new Date(2026, 10, 2, 21, 40).toISOString();
    expect(formatWaitingForAi("Claude Code is signed out", evening)).toBe(
      "Waiting for the AI: Claude Code is signed out. Next try at 21:40.",
    );
  });
});

describe("retryableJobIds", () => {
  const job = (
    id: string,
    status: JobRow["status"],
    retry_of_job_id: string | null = null,
  ): Pick<JobRow, "id" | "status" | "retry_of_job_id"> => ({ id, status, retry_of_job_id });

  it("lists failed jobs no other job retries", () => {
    const jobs = [
      job("a", "failed"),
      job("b", "done"),
      job("c", "failed"),
      job("d", "queued", "c"),
    ];
    expect(retryableJobIds({ status: "processed" }, jobs)).toEqual(["a"]);
    expect(retryableJobIds({ status: "failed" }, [job("a", "failed")])).toEqual(["a"]);
  });

  it("lists none while the reel is refused", () => {
    expect(retryableJobIds({ status: "refused" }, [job("a", "failed")])).toEqual([]);
  });
});

describe("changeQueueNote", () => {
  const job = (kind: string, status: JobRow["status"]) => ({ kind, status });

  it("waits for processing while a process job is live", () => {
    for (const status of ["queued", "running", "waiting_ai"] as const) {
      expect(changeQueueNote([job("render", "queued"), job("process", status)])).toBe(
        "Your change will run after processing finishes.",
      );
    }
  });

  it("waits for the other live jobs", () => {
    for (const status of ["queued", "running", "waiting_ai"] as const) {
      expect(changeQueueNote([job("process", "done"), job("change", status)])).toBe(
        "Your change will run after the jobs before it finish.",
      );
    }
  });

  it("is null when nothing is ahead", () => {
    expect(changeQueueNote([])).toBeNull();
    expect(changeQueueNote([job("process", "failed"), job("change", "done")])).toBeNull();
  });
});
