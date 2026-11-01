import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { type ClaimedJob, failJob, finishJob } from "./queue.ts";

const CONFIG = { workerId: "w1", leaseSeconds: 60 };
const JOB: ClaimedJob = {
  id: "j1",
  reel_id: "r1",
  owner_id: "o1",
  kind: "process",
  attempts: 1,
  request: null,
  restore_version_id: null,
};

// Records every update by table; the job update matches one row (the lease
// is still held).
function stubDb() {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      const chain = {
        update(values: Record<string, unknown>) {
          updates.push({ table, values });
          return chain;
        },
        eq() {
          return chain;
        },
        select() {
          return Promise.resolve({ data: [{ id: JOB.id }], error: null });
        },
        then(resolve: (value: { error: null }) => void) {
          resolve({ error: null });
        },
      };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

describe("ending a job", () => {
  it("moves a process job's reel to processed or failed", async () => {
    const done = stubDb();
    await finishJob(done.db, CONFIG, JOB);
    expect(done.updates.map((update) => update.table)).toEqual(["jobs", "reels"]);
    expect(done.updates[1]!.values).toEqual({ status: "processed" });
    const failed = stubDb();
    await failJob(failed.db, CONFIG, JOB, "tail");
    expect(failed.updates[1]!.values).toEqual({ status: "failed" });
  });

  it("never touches the reel for a change or restore job", async () => {
    for (const job of [
      { ...JOB, kind: "change", request: "lower title" },
      { ...JOB, kind: "restore", restore_version_id: "v1" },
    ]) {
      const failed = stubDb();
      expect(await failJob(failed.db, CONFIG, job, "decide failed twice")).toBe(true);
      expect(failed.updates.map((update) => update.table)).toEqual(["jobs"]);
      const done = stubDb();
      expect(await finishJob(done.db, CONFIG, job)).toBe(true);
      expect(done.updates.map((update) => update.table)).toEqual(["jobs"]);
    }
  });
});
