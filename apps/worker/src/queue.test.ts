import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  AI_RETRY_AFTER_SECONDS,
  type ClaimedJob,
  claimableFilter,
  failJob,
  finishJob,
  refuseJob,
  waitForAi,
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
    retry_of_job_id: null,
    waiting_reason: null,
    not_before: null,
  };
}

// A client that records each table's update and answers as if this worker
// still holds the lease.
function stubClient() {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      const result = { data: [{ id: "j1" }], error: null };
      const builder = {
        update(values: Record<string, unknown>) {
          updates.push({ table, values });
          return builder;
        },
        eq: () => builder,
        select: () => builder,
        then: (resolve: (value: typeof result) => unknown) => resolve(result),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, updates };
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

describe("refusing and waiting", () => {
  it("refuses: the job failed with the message, the reel refused with it", async () => {
    const refused = stubClient();
    const message = "This clip has no sound; the studio needs the voice.";
    expect(await refuseJob(refused.db, CONFIG, job("process"), message)).toBe(true);
    expect(refused.updates.map((u) => u.table)).toEqual(["jobs", "reels"]);
    expect(refused.updates[0]?.values).toMatchObject({ status: "failed", error_tail: message });
    expect(refused.updates[1]?.values).toEqual({ status: "refused", refusal_message: message });
  });

  it("waits through wait_for_ai with 15 minutes, by the database clock", async () => {
    const rpcs: { name: string; args: Record<string, unknown> }[] = [];
    const db = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcs.push({ name, args });
        return { data: true, error: null, status: 200 };
      },
    } as unknown as SupabaseClient;
    expect(await waitForAi(db, CONFIG, job("process"), "usage limit reached")).toBe(true);
    expect(AI_RETRY_AFTER_SECONDS).toBe(900);
    expect(rpcs).toEqual([
      {
        name: "wait_for_ai",
        args: {
          p_job_id: "j1",
          p_worker: "w1",
          p_reason: "usage limit reached",
          p_retry_after_seconds: 900,
        },
      },
    ]);
  });
});

describe("claimableFilter", () => {
  it("wakes for queued, expired and waiting-past-its-time jobs", () => {
    const now = new Date("2026-11-02T10:00:00.000Z");
    expect(claimableFilter(now)).toBe(
      "status.eq.queued," +
        "and(status.eq.running,lease_expires_at.lt.2026-11-02T10:00:00.000Z)," +
        "and(status.eq.waiting_ai,not_before.lte.2026-11-02T10:00:00.000Z)",
    );
  });
});
