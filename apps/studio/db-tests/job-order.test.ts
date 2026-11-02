import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, deleteTestUser, insertReel } from "../test-support/fixtures.ts";
import { localDbUrl, localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// claim_job's order (app_docs/failures.md): one job per reel at a time, in
// order, a waiting job skipped until its `not_before`. Every time is set on
// the database clock (now() in SQL), never compared with the host's.

interface ClaimedRow {
  id: string;
  reel_id: string;
  kind: string;
  attempts: number;
  waiting_reason: string | null;
  not_before: string | null;
}

const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let db: pg.Client;

async function newReel(name: string): Promise<string> {
  return insertReel(admin, { ownerId: owner.id, name, status: "uploaded" });
}

// A job created `secondsAgo` before the database's now, with any extra
// columns (`not_before` and `lease_expires_at` as seconds from now).
async function insertJob(
  reelId: string,
  secondsAgo: number,
  {
    kind = "process",
    status = "queued",
    notBeforeIn = null,
    leaseExpiresIn = null,
  }: {
    kind?: "process" | "change";
    status?: "queued" | "running" | "waiting_ai";
    notBeforeIn?: number | null;
    leaseExpiresIn?: number | null;
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.jobs
       (reel_id, owner_id, kind, request, status, waiting_reason, not_before,
        lease_holder, lease_expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6,
       case when $7::int is null then null else now() + make_interval(secs => $7::int) end,
       $8,
       case when $9::int is null then null else now() + make_interval(secs => $9::int) end,
       now() - make_interval(secs => $10::int))
     returning id`,
    [
      reelId,
      owner.id,
      kind,
      kind === "change" ? "move the title lower" : null,
      status,
      status === "waiting_ai" ? "the usage limit is reached" : null,
      notBeforeIn,
      status === "running" ? "job-order-held" : null,
      leaseExpiresIn,
      secondsAgo,
    ],
  );
  return rows[0]!.id;
}

async function claim(worker = "job-order"): Promise<ClaimedRow[]> {
  const { rows } = await db.query<ClaimedRow>("select * from public.claim_job($1, 300)", [worker]);
  return rows;
}

async function setDone(ids: string[]): Promise<void> {
  await db.query(
    `update public.jobs
     set status = 'done', finished_at = now(), lease_expires_at = null,
         waiting_reason = null, not_before = null
     where id = any($1::uuid[])`,
    [ids],
  );
}

beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "job-order");
  db = new pg.Client({ connectionString: localDbUrl() });
  await db.connect();
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  if (owner) {
    await db.query(
      `update public.jobs set status = 'done', lease_expires_at = null,
         waiting_reason = null, not_before = null
       where owner_id = $1 and status in ('queued', 'running', 'waiting_ai')`,
      [owner.id],
    );
  }
  await db?.end();
  if (owner) await deleteTestUser(admin, owner.id);
});

describe("claim_job order", () => {
  it("takes one job per reel at a time, in order, and other reels' jobs meanwhile", async () => {
    const reelA = await newReel("a.mov");
    const reelB = await newReel("b.mov");
    const processA = await insertJob(reelA, 300);
    const processB = await insertJob(reelB, 200);
    const changeA = await insertJob(reelA, 100, { kind: "change" });

    expect((await claim()).map((job) => job.id)).toEqual([processA]);
    // Not A's change: A's process is running.
    expect((await claim()).map((job) => job.id)).toEqual([processB]);
    expect(await claim()).toEqual([]);

    await setDone([processA]);
    expect((await claim()).map((job) => job.id)).toEqual([changeA]);
    await setDone([processB, changeA]);
  });

  it("skips a waiting job until its next try, and holds its reel's newer job", async () => {
    const reelC = await newReel("c.mov");
    const reelD = await newReel("d.mov");
    const waiting = await insertJob(reelC, 300, { status: "waiting_ai", notBeforeIn: 3600 });
    const newerC = await insertJob(reelC, 200, { kind: "change" });
    const queuedD = await insertJob(reelD, 100);

    expect((await claim()).map((job) => job.id)).toEqual([queuedD]);
    // The waiting job is not due, and C's change waits behind it.
    expect(await claim()).toEqual([]);

    await db.query("update public.jobs set not_before = now() - interval '1 hour' where id = $1", [
      waiting,
    ]);
    const [claimed] = await claim();
    expect(claimed).toMatchObject({
      id: waiting,
      attempts: 1,
      waiting_reason: null,
      not_before: null,
    });
    // C's change still waits: C's job is running now.
    expect(await claim()).toEqual([]);
    await setDone([waiting, newerC, queuedD]);
  });

  it("re-claims a reel's job whose lease expired, never its newer job", async () => {
    const reelE = await newReel("e.mov");
    const running = await insertJob(reelE, 300, { status: "running", leaseExpiresIn: -60 });
    const newerE = await insertJob(reelE, 100, { kind: "change" });

    const [claimed] = await claim("job-order-b");
    expect(claimed?.id).toBe(running);
    expect(claimed?.attempts).toBe(1);
    expect(await claim()).toEqual([]);
    await setDone([running, newerE]);
  });
});

interface ClaimEvent {
  jobId: string;
  reel: string;
  kind: string;
  start: number;
  end: number;
}

// Which of the per-reel rules a run broke: two jobs of one reel overlapping,
// or a reel's change starting before its process ended.
function orderViolations(events: readonly ClaimEvent[]): string[] {
  const violations: string[] = [];
  for (const [index, a] of events.entries()) {
    for (const b of events.slice(index + 1)) {
      if (a.reel !== b.reel) continue;
      if (a.start < b.end && b.start < a.end) violations.push(`${a.jobId} overlaps ${b.jobId}`);
    }
  }
  for (const change of events.filter((event) => event.kind === "change")) {
    const process = events.find((event) => event.reel === change.reel && event.kind === "process");
    if (process && change.start < process.end) {
      violations.push(`${change.jobId} started before ${process.jobId} ended`);
    }
  }
  return violations;
}

// The old claim_job (20261031174750_job_queue.sql): no `not_before`, no
// per-reel condition. Created in each session's own temporary schema, never
// in the database's.
const UNORDERED = `
create function pg_temp.claim_job_unordered(p_worker text, p_lease_seconds int)
returns setof public.jobs
language plpgsql
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
$$;`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Two workers, each its own session, claiming in a loop until the three jobs
// are done. A's process is held longest, so a worker free early tries A's
// change while it runs. The start is taken after the claim returned and the
// end before the job is released, so a recorded overlap is a real one.
async function twoWorkers(claimSql: string): Promise<{ events: ClaimEvent[]; reels: string[] }> {
  const reelA = await newReel("loop-a.mov");
  const reelB = await newReel("loop-b.mov");
  const jobs = [
    await insertJob(reelA, 30),
    await insertJob(reelB, 20),
    await insertJob(reelA, 10, { kind: "change" }),
  ];
  const clients = [0, 1].map(() => new pg.Client({ connectionString: localDbUrl() }));
  const events: ClaimEvent[] = [];
  try {
    for (const client of clients) {
      await client.connect();
      await client.query(UNORDERED);
    }
    const remaining = new Set(jobs);
    const run = async (client: pg.Client, worker: string) => {
      for (let round = 0; round < 500 && remaining.size > 0; round += 1) {
        const { rows } = await client.query<ClaimedRow>(claimSql, [worker]);
        const job = rows[0];
        if (!job) {
          await sleep(2);
          continue;
        }
        const start = performance.now();
        await sleep(job.reel_id === reelA && job.kind === "process" ? 80 : 10);
        const end = performance.now();
        events.push({ jobId: job.id, reel: job.reel_id, kind: job.kind, start, end });
        await client.query(
          "update public.jobs set status = 'done', finished_at = now(), lease_expires_at = null where id = $1",
          [job.id],
        );
        remaining.delete(job.id);
      }
    };
    await Promise.all([run(clients[0]!, "loop-1"), run(clients[1]!, "loop-2")]);
  } finally {
    await setDone(jobs);
    for (const client of clients) await client.end();
  }
  return { events, reels: [reelA, reelB] };
}

describe("two workers in a loop", () => {
  it("never run two jobs of a reel together or out of order", async () => {
    const { events, reels } = await twoWorkers("select * from public.claim_job($1, 60)");
    expect(events).toHaveLength(3);
    expect(orderViolations(events)).toEqual([]);
    const processA = events.find((e) => e.reel === reels[0] && e.kind === "process")!;
    const jobB = events.find((e) => e.reel === reels[1])!;
    // B's job ran beside A's process.
    expect(jobB.start < processA.end && processA.start < jobB.end).toBe(true);
  });

  it("break the order under the old claim_job (the check can fail)", async () => {
    const { events } = await twoWorkers("select * from pg_temp.claim_job_unordered($1, 60)");
    expect(events).toHaveLength(3);
    expect(orderViolations(events).length).toBeGreaterThan(0);
  });
});
