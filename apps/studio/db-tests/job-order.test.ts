import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, deleteTestUser, insertReel } from "../test-support/fixtures.ts";
import { localDbUrl, localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// One job at a time per reel, in order, enforced in claim_job (Verification 7).
// Two workers claim concurrently through a claim function and hold each job a
// moment. The negative proof runs the same loop through a copy of claim_job
// without the per-reel condition: it must overlap one reel's jobs, so removing
// the condition from claim_job makes the ordered case fail.
const admin = localSupabaseAdmin();
const HOLD_MS = 150;
let owner: { id: string; email: string };
let setup: pg.Client;

const UNORDERED = `
create function public.claim_job_unordered_for_test(p_worker text, p_lease_seconds int)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with next as (
    select c.id
    from public.jobs c
    where c.status = 'queued' or (c.status = 'running' and c.lease_expires_at < now())
    order by c.created_at, c.id
    limit 1
    for update skip locked
  )
  update public.jobs j
  set status = 'running',
      lease_holder = p_worker,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      started_at = now()
  from next
  where j.id = next.id
  returning j.*;
end;
$$;
revoke execute on function public.claim_job_unordered_for_test(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_job_unordered_for_test(text, int) to service_role;
`;

interface Interval {
  jobId: string;
  start: number;
  end: number;
}

interface Queued {
  aProcess: string;
  aChange: string;
  bProcess: string;
  reels: string[];
}

async function insertJob(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from("jobs").insert(row).select("id").single();
  if (error || !data) throw new Error(`job not inserted: ${error?.message}`);
  return data.id as string;
}

// Reel A: a process job, then a change; reel B: a process job. Increasing created_at.
async function queue(): Promise<Queued> {
  const reelA = await insertReel(admin, { ownerId: owner.id, status: "processed" });
  const reelB = await insertReel(admin, { ownerId: owner.id, status: "processed" });
  const at = (seconds: number) => new Date(Date.now() - 600_000 + seconds * 1000).toISOString();
  const base = { owner_id: owner.id };
  return {
    aProcess: await insertJob({ ...base, reel_id: reelA, kind: "process", created_at: at(0) }),
    aChange: await insertJob({
      ...base,
      reel_id: reelA,
      kind: "change",
      request: "move the title lower",
      created_at: at(1),
    }),
    bProcess: await insertJob({ ...base, reel_id: reelB, kind: "process", created_at: at(2) }),
    reels: [reelA, reelB],
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Two workers, each on its own connection, claiming until there is nothing to claim.
async function drain(claimFunction: string): Promise<Interval[]> {
  const intervals: Interval[] = [];
  const worker = async (name: string) => {
    const db = new pg.Client({ connectionString: localDbUrl() });
    await db.connect();
    try {
      for (;;) {
        // The function name is one of two fixed literals.
        const { rows } = await db.query<{ id: string }>(
          `select id from public.${claimFunction}($1, 60)`,
          [name],
        );
        const jobId = rows[0]?.id;
        if (!jobId) return;
        const start = Date.now();
        await sleep(HOLD_MS);
        await db.query(
          `update public.jobs set status = 'done', finished_at = now(), lease_expires_at = null
           where id = $1`,
          [jobId],
        );
        intervals.push({ jobId, start, end: Date.now() });
      }
    } finally {
      await db.end();
    }
  };
  await Promise.all([worker("order-1"), worker("order-2")]);
  return intervals;
}

function overlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function of(intervals: Interval[], jobId: string): Interval {
  const interval = intervals.find((entry) => entry.jobId === jobId);
  if (!interval) throw new Error(`job ${jobId} never ran: ${JSON.stringify(intervals)}`);
  return interval;
}

async function clean(queued: Queued) {
  for (const reel of queued.reels) await admin.from("jobs").delete().eq("reel_id", reel);
}

beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "job-order");
  setup = new pg.Client({ connectionString: localDbUrl() });
  await setup.connect();
  await setup.query("drop function if exists public.claim_job_unordered_for_test(text, int)");
  await setup.query(UNORDERED);
});

afterAll(async () => {
  if (setup) {
    await setup.query("drop function if exists public.claim_job_unordered_for_test(text, int)");
    await setup.end();
  }
  if (owner) await deleteTestUser(admin, owner.id);
});

describe("claim_job's per-reel order", () => {
  it("runs one reel's jobs one at a time, in order, and another reel's beside them", async () => {
    const queued = await queue();
    try {
      const intervals = await drain("claim_job");
      expect(intervals).toHaveLength(3);
      const aProcess = of(intervals, queued.aProcess);
      const aChange = of(intervals, queued.aChange);
      const bProcess = of(intervals, queued.bProcess);
      expect(overlap(aProcess, aChange)).toBe(false);
      expect(aChange.start).toBeGreaterThanOrEqual(aProcess.end);
      expect(overlap(bProcess, aProcess) || overlap(bProcess, aChange)).toBe(true);
    } finally {
      await clean(queued);
    }
  });

  it("negative proof: without the per-reel condition one reel's jobs overlap", async () => {
    const queued = await queue();
    try {
      const intervals = await drain("claim_job_unordered_for_test");
      expect(intervals).toHaveLength(3);
      expect(overlap(of(intervals, queued.aProcess), of(intervals, queued.aChange))).toBe(true);
    } finally {
      await clean(queued);
    }
  });
});
