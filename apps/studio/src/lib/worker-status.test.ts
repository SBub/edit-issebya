import { describe, expect, it } from "vitest";
import {
  WORKER_STATUS_COLUMNS,
  type WorkerStatusRow,
  upsertWorkerStatus,
  waitingReasonOf,
} from "./worker-status";

const row = (worker_id: string, waiting_reason: string | null, updated_at: string) =>
  ({ worker_id, waiting_reason, updated_at }) satisfies WorkerStatusRow;

describe("WORKER_STATUS_COLUMNS", () => {
  it("names its columns", () => {
    expect(WORKER_STATUS_COLUMNS).not.toContain("*");
  });
});

describe("waitingReasonOf", () => {
  it("gives null without rows or reasons", () => {
    expect(waitingReasonOf([])).toBeNull();
    expect(waitingReasonOf([row("a", null, "2026-11-01T10:00:00Z")])).toBeNull();
  });

  it("gives the newest reason", () => {
    expect(
      waitingReasonOf([
        row("a", "waiting: old", "2026-11-01T10:00:00Z"),
        row("b", "waiting: new", "2026-11-01T11:00:00Z"),
        row("c", null, "2026-11-01T12:00:00Z"),
      ]),
    ).toBe("waiting: new");
  });

  it("clears a worker's reason when its later row has none, keeping another's", () => {
    let rows = [
      row("a", "waiting: a", "2026-11-01T10:00:00Z"),
      row("b", "waiting: b", "2026-11-01T09:00:00Z"),
    ];
    rows = upsertWorkerStatus(rows, row("a", null, "2026-11-01T10:05:00Z"));
    expect(waitingReasonOf(rows)).toBe("waiting: b");
    rows = upsertWorkerStatus(rows, row("b", null, "2026-11-01T10:06:00Z"));
    expect(waitingReasonOf(rows)).toBeNull();
    expect(rows).toHaveLength(2);
  });
});
