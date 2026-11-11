import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { TEST_JOB } from "./recording-steps.ts";
import { supabaseStepStore } from "./step-store.ts";

// A Supabase stand-in that records each write's table operation and payload.
function fakeDb() {
  const writes: Array<{ op: "insert" | "update"; payload: Record<string, unknown> }> = [];
  const builder = (op: "insert" | "update", payload: Record<string, unknown>) => {
    writes.push({ op, payload });
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      single: async () => ({ data: { id: "step-1" }, error: null }),
      then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
    };
    return chain;
  };
  const db = {
    from: () => ({
      insert: (payload: Record<string, unknown>) => builder("insert", payload),
      update: (payload: Record<string, unknown>) => builder("update", payload),
    }),
  } as unknown as SupabaseClient;
  return { db, writes };
}

const STARTED = new Date("2026-11-10T13:55:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("step rows agree with their wall time", () => {
  const measurements = {
    wall_ms: 218,
    cpu_ms: null,
    peak_rss_bytes: null,
    bytes_in: null,
    bytes_out: null,
  };

  it("starts a row at the worker's start instant", async () => {
    const { db, writes } = fakeDb();
    await supabaseStepStore(db).start(TEST_JOB, "decide", STARTED);
    expect(writes[0]).toMatchObject({
      op: "insert",
      payload: { started_at: iso(STARTED.getTime()) },
    });
  });

  it("finishes a done, failed or waiting row exactly wall_ms after it started", async () => {
    const { db, writes } = fakeDb();
    const steps = supabaseStepStore(db);
    await steps.done("s1", "ok", measurements, STARTED);
    await steps.failed("s2", "tail", "failed", measurements, STARTED);
    await steps.waiting("s3", "no key", "waiting", measurements, STARTED);
    const finished = writes.map((write) => write.payload.finished_at);
    expect(finished).toEqual([
      iso(STARTED.getTime() + 218),
      iso(STARTED.getTime() + 218),
      iso(STARTED.getTime() + 218),
    ]);
  });

  it("writes a cache hit's skipped row with the same start and finish as its wall time", async () => {
    const { db, writes } = fakeDb();
    await supabaseStepStore(db).skipped(TEST_JOB, "cutout", "reused", 150, STARTED);
    expect(writes[0]?.payload).toMatchObject({
      status: "skipped",
      started_at: iso(STARTED.getTime()),
      finished_at: iso(STARTED.getTime() + 150),
      wall_ms: 150,
    });
  });
});
