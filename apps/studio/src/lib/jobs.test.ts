import { describe, expect, it } from "vitest";
import {
  JOB_COLUMNS,
  JOB_STATUSES,
  STEP_COLUMNS,
  STEP_STATUSES,
  isUnfinished,
  pickColumns,
  upsertById,
} from "./jobs";

describe("columns", () => {
  it("never selects every column and carries no lease column", () => {
    for (const columns of [JOB_COLUMNS, STEP_COLUMNS]) {
      expect(columns).not.toContain("*");
      expect(columns).not.toContain("lease");
    }
  });
});

describe("status lists", () => {
  it("match the check constraints of public.jobs and public.steps", () => {
    expect(JOB_STATUSES).toEqual(["queued", "running", "waiting_ai", "done", "failed"]);
    expect(STEP_STATUSES).toEqual(["running", "done", "failed", "skipped", "waiting_ai"]);
  });
});

describe("isUnfinished", () => {
  it("is queued, running or waiting for the AI", () => {
    expect(JOB_STATUSES.filter((status) => isUnfinished({ status }))).toEqual([
      "queued",
      "running",
      "waiting_ai",
    ]);
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
