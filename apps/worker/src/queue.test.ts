import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  AI_RETRY_MINUTES,
  type ClaimedJob,
  claimableJobIds,
  failJob,
  finishJob,
  refuseJob,
  waitJob,
} from "./queue.ts";

const CONFIG = { workerId: "w1", leaseSeconds: 60 };

function job(kind: string): ClaimedJob {
  return {
    id: "j1",
    reel_id: "r1",
    owner_id: "o1",
    kind,
    attempts: 1,
    request: kind === "change" ? "move the title lower" : null,
    restore_version_id: kind === "restore" ? "v1" : null,
    version_id: kind === "render" ? "v2" : null,
  };
}

// A client that records each table's update and answers as if this worker
// still holds the lease.
function stubClient({ holds = true }: { holds?: boolean } = {}) {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const filters: string[] = [];
  const db = {
    from(table: string) {
      const result = { data: holds ? [{ id: "j1" }] : [], error: null };
      const builder = {
        update(values: Record<string, unknown>) {
          updates.push({ table, values });
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push(`${table}.${column}=${String(value)}`);
          return builder;
        },
        or: (filter: string) => {
          filters.push(filter);
          return builder;
        },
        limit: () => builder,
        select: () => builder,
        then: (resolve: (value: typeof result) => unknown) => resolve(result),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, updates, filters };
}

describe("ending a job", () => {
  it("moves the reel's status for a process job", async () => {
    const done = stubClient();
    expect(await finishJob(done.db, CONFIG, job("process"))).toBe(true);
    expect(done.updates.map((u) => u.table)).toEqual(["jobs", "reels"]);
    expect(done.updates[1]?.values).toEqual({ status: "processed" });

    const failed = stubClient();
    expect(await failJob(failed.db, CONFIG, job("process"), "boom")).toBe(true);
    expect(failed.updates[1]?.values).toEqual({ status: "failed" });
  });

  for (const kind of ["change", "restore", "render"]) {
    it(`never writes the reel's status for a ${kind} job, finished or failed`, async () => {
      const done = stubClient();
      expect(await finishJob(done.db, CONFIG, job(kind))).toBe(true);
      expect(done.updates.map((u) => u.table)).toEqual(["jobs"]);
      expect(done.updates[0]?.values).toMatchObject({ status: "done" });

      const failed = stubClient();
      expect(await failJob(failed.db, CONFIG, job(kind), "decide: the answer failed twice")).toBe(
        true,
      );
      expect(failed.updates.map((u) => u.table)).toEqual(["jobs"]);
      expect(failed.updates[0]?.values).toMatchObject({
        status: "failed",
        error_tail: "decide: the answer failed twice",
      });
    });
  }
});

describe("refusing a job", () => {
  it("fails the job with the message, then refuses the reel with it", async () => {
    const { db, updates, filters } = stubClient();
    expect(await refuseJob(db, CONFIG, job("process"), "This clip has no sound.")).toBe(true);
    expect(updates.map((u) => u.table)).toEqual(["jobs", "reels"]);
    expect(updates[0]?.values).toMatchObject({
      status: "failed",
      error_tail: "This clip has no sound.",
      lease_expires_at: null,
    });
    expect(updates[1]?.values).toEqual({
      status: "refused",
      refusal_message: "This clip has no sound.",
    });
    expect(filters).toEqual(
      expect.arrayContaining(["jobs.lease_holder=w1", "jobs.status=running"]),
    );
  });

  it("leaves the reel alone when another worker holds the lease", async () => {
    const { db, updates } = stubClient({ holds: false });
    expect(await refuseJob(db, CONFIG, job("process"), "This file is not a video.")).toBe(false);
    expect(updates.map((u) => u.table)).toEqual(["jobs"]);
  });
});

describe("making a job wait for the AI", () => {
  it("sets waiting_ai, the reason and not_before 15 minutes ahead, giving up the lease", async () => {
    const { db, updates, filters } = stubClient();
    const now = new Date("2026-11-02T10:00:00.000Z");
    expect(await waitJob(db, CONFIG, job("change"), "the usage limit is reached", now)).toBe(true);
    expect(AI_RETRY_MINUTES).toBe(15);
    expect(updates).toEqual([
      {
        table: "jobs",
        values: {
          status: "waiting_ai",
          waiting_reason: "the usage limit is reached",
          not_before: "2026-11-02T10:15:00.000Z",
          lease_expires_at: null,
          lease_holder: null,
        },
      },
    ]);
    expect(filters).toEqual(
      expect.arrayContaining(["jobs.lease_holder=w1", "jobs.status=running"]),
    );
  });

  it("is false when the lease is gone", async () => {
    const { db } = stubClient({ holds: false });
    expect(await waitJob(db, CONFIG, job("process"), "Claude Code is signed out")).toBe(false);
  });
});

describe("claimableJobIds", () => {
  it("also counts jobs waiting for the AI past their not_before", async () => {
    const { db, filters } = stubClient();
    expect(await claimableJobIds(db)).toEqual(["j1"]);
    const filter = filters.find((f) => f.startsWith("status.eq.queued"));
    expect(filter).toMatch(/and\(status\.eq\.waiting_ai,not_before\.lt\.[0-9T:.Z-]+\)/);
    expect(filter).toMatch(/and\(status\.eq\.running,lease_expires_at\.lt\./);
  });
});
