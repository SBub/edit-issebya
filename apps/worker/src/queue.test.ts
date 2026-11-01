import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { type ClaimedJob, failJob, finishJob } from "./queue.ts";

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

  for (const kind of ["change", "restore"]) {
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
