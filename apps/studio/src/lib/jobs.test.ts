import { describe, expect, it } from "vitest";
import {
  JOB_COLUMNS,
  JOB_STATUSES,
  STEP_COLUMNS,
  STEP_STATUSES,
  WORKER_STATUS_COLUMNS,
  type WorkerStatusRow,
  pickColumns,
  upsertById,
  waitingReason,
} from "./jobs";

describe("columns", () => {
  it("never selects every column and carries no lease column", () => {
    for (const columns of [JOB_COLUMNS, STEP_COLUMNS, WORKER_STATUS_COLUMNS]) {
      expect(columns).not.toContain("*");
      expect(columns).not.toContain("lease");
    }
  });
});

describe("status lists", () => {
  it("match the check constraints of public.jobs and public.steps", () => {
    expect(JOB_STATUSES).toEqual(["queued", "running", "done", "failed"]);
    expect(STEP_STATUSES).toEqual(["running", "done", "failed"]);
  });
});

describe("upsertById", () => {
  const a = { id: "a", at: "2026-01-02", v: 1 };
  const b = { id: "b", at: "2026-01-01", v: 1 };

  it("inserts and orders", () => {
    expect(upsertById([a], b, "at")).toEqual([b, a]);
  });

  it("replaces by id", () => {
    expect(upsertById([b, a], { ...a, v: 2 }, "at")).toEqual([b, { ...a, v: 2 }]);
  });

  it("breaks ties by id", () => {
    const c = { id: "c", at: "2026-01-01", v: 1 };
    expect(upsertById([c], b, "at")).toEqual([b, c]);
  });
});

describe("pickColumns", () => {
  it("drops keys outside the list", () => {
    expect(
      pickColumns({ id: "1", status: "done", lease_holder: "w", extra: 1 }, "id, status"),
    ).toEqual({ id: "1", status: "done" });
  });
});

describe("waitingReason", () => {
  const status = (worker_id: string, waiting_reason: string | null, updated_at: string) =>
    ({ worker_id, waiting_reason, updated_at }) satisfies WorkerStatusRow;

  it("is null without statuses or reasons", () => {
    expect(waitingReason([])).toBeNull();
    expect(waitingReason([status("w1", null, "2026-11-01T10:00:00Z")])).toBeNull();
  });

  it("picks the newest reason", () => {
    expect(
      waitingReason([
        status("w1", "waiting: old", "2026-11-01T10:00:00Z"),
        status("w2", "waiting: new", "2026-11-01T11:00:00Z"),
        status("w3", null, "2026-11-01T12:00:00Z"),
      ]),
    ).toBe("waiting: new");
  });
});
