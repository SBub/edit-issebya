import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNCED_TABLES } from "../scripts/posthog-dashboard/config.ts";
import { postgres } from "../scripts/posthog-dashboard/dialect.ts";
import type { SqlInsight } from "../scripts/posthog-dashboard/insights/common.ts";
import { INSIGHTS } from "../scripts/posthog-dashboard/insights/index.ts";
import { columnReferences, eventNames } from "../scripts/posthog-dashboard/sql-references.ts";
import { STUDIO_EVENTS } from "../src/lib/studio-events.ts";
import { createTestUser, deleteTestUser } from "../test-support/fixtures.ts";
import { localDbUrl, localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The dashboard's queries against the real schema: every column and event they
// name exists, and their Postgres rendering (the same SQL text as the HogQL
// payload, app_docs/dashboard.md) gives the expected numbers on seeded rows.
// The metric rows live in one transaction that is rolled back.

const admin = localSupabaseAdmin();
const SQL_INSIGHTS = INSIGHTS.filter((def): def is SqlInsight => def.kind === "sql");

function byKey(key: string): SqlInsight {
  const def = SQL_INSIGHTS.find((insight) => insight.key === key);
  if (!def) throw new Error(`no insight ${key}`);
  return def;
}

describe("dashboard queries name real columns and events", () => {
  it("read only synced tables and their existing columns", async () => {
    const db = new pg.Client({ connectionString: localDbUrl() });
    await db.connect();
    try {
      const { rows } = await db.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and table_name = any($1)`,
        [[...SYNCED_TABLES]],
      );
      const existing = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
      expect(SQL_INSIGHTS).toHaveLength(19);
      for (const def of SQL_INSIGHTS) {
        const tables: string[] = [];
        const sql = def.build(postgres, (name) => {
          tables.push(name);
          return name;
        });
        expect(tables.length, def.key).toBeGreaterThan(0);
        for (const table of tables) expect(SYNCED_TABLES, def.key).toContain(table);
        const pairs = columnReferences(sql);
        expect(pairs.length, def.key).toBeGreaterThan(0);
        for (const [table, column] of pairs) {
          expect(existing.has(`${table}.${column}`), `${def.key}: ${table}.${column}`).toBe(true);
        }
        for (const event of eventNames(sql)) expect(STUDIO_EVENTS).toContain(event);
      }
    } finally {
      await db.end();
    }
  });

  it("send only studio events in the funnel", () => {
    const funnel = INSIGHTS.find((def) => def.kind === "funnel");
    expect(funnel?.kind === "funnel" ? [...funnel.events] : []).toEqual([...STUDIO_EVENTS]);
  });
});

describe("dashboard metric logic", () => {
  const db = new pg.Client({ connectionString: localDbUrl() });
  const schema = `dash_test_${randomUUID().slice(0, 8)}`;
  const prefix = `dash-test-${randomUUID().slice(0, 8)}/`;
  let owner: { id: string; email: string };
  // Monday 2 March 2026, 10:00 UTC: every row falls in one week.
  const T = Date.parse("2026-03-02T10:00:00Z");
  const at = (minutes: number) => new Date(T + minutes * 60_000).toISOString();

  async function run(key: string) {
    const { rows } = await db.query(byKey(key).build(postgres, (name) => `${schema}.${name}`));
    return rows as Record<string, unknown>[];
  }
  const num = (value: unknown) => Number(value);

  async function reel(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.reels (owner_id, status) values ($1, 'processed') returning id`,
      [owner.id],
    );
    return rows[0]!.id;
  }

  async function job(
    reelId: string,
    kind: string,
    minutes: number,
    extra: Record<string, unknown> = {},
  ) {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.jobs
         (reel_id, owner_id, kind, status, created_at, request, version_id, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        reelId,
        owner.id,
        kind,
        extra.status ?? "done",
        at(minutes),
        extra.request ?? null,
        extra.versionId ?? null,
        typeof extra.started === "number" ? at(extra.started) : null,
        typeof extra.finished === "number" ? at(extra.finished) : null,
      ],
    );
    return rows[0]!.id;
  }

  async function version(reelId: string, minutes: number): Promise<string> {
    const id = randomUUID();
    await db.query(
      `insert into public.versions (id, reel_id, owner_id, number, inputs, r2_key, created_at)
       values ($1, $2, $3, 1, '{}'::jsonb, $4, $5)`,
      [id, reelId, owner.id, `${prefix}${id}.json`, at(minutes)],
    );
    return id;
  }

  async function exported(reelId: string, versionId: string, minutes: number) {
    const renderJob = await job(reelId, "render", minutes - 5, { versionId });
    const id = randomUUID();
    await db.query(
      `insert into public.exports (id, reel_id, owner_id, job_id, version_id, r2_key, bytes, created_at)
       values ($1, $2, $3, $4, $5, $6, 10, $7)`,
      [id, reelId, owner.id, renderJob, versionId, `${prefix}${id}.mp4`, at(minutes)],
    );
    return renderJob;
  }

  async function step(jobId: string, reelId: string, values: Record<string, unknown>) {
    const columns = Object.keys(values);
    await db.query(
      `insert into public.steps (job_id, reel_id, owner_id, ${columns.join(", ")})
       values ($1, $2, $3, ${columns.map((_, i) => `$${i + 4}`).join(", ")})`,
      [jobId, reelId, owner.id, ...Object.values(values)],
    );
  }

  async function stored(reelId: string, step: string, key: string, bytes: number, deleted = false) {
    await db.query(
      `insert into public.stored_files (reel_id, owner_id, step, r2_key, bytes, kind, created_at, deleted_at)
       values ($1, $2, $3, $4, $5, 'rebuildable', $6, $7)`,
      [reelId, owner.id, step, `${prefix}${key}`, bytes, at(0), deleted ? at(1) : null],
    );
  }

  beforeAll(async () => {
    owner = await createTestUser(admin, "dashboard");
    await db.connect();
    await db.query("begin");
    await db.query(`create schema ${schema}`);
    // Views over the seeded user's rows only, so other data on the stack never counts.
    for (const table of SYNCED_TABLES) {
      await db.query(
        `create view ${schema}.${table} as select * from public.${table} where owner_id = '${owner.id}'`,
      );
    }

    const a = await reel();
    const b = await reel();
    const c = await reel();
    const d = await reel();
    // A's size (the worker writes it after check_footage and retime); B, C
    // and D have none, so the length insight reads A's steps only.
    await db.query(
      `update public.reels set source_seconds = 20, footage_seconds = 16 where id = $1`,
      [a],
    );
    // Process jobs at T, T+1h, T+2h, T+3h; A also has a later Retry process job.
    // Claimed after 1, 1, 2 and 3 minutes; run 3 (done), 1 (failed), 6 (done)
    // minutes, C still running and D still queued.
    const jobA = await job(a, "process", 0, { started: 1, finished: 4 });
    await job(a, "process", 5, { status: "failed", started: 6, finished: 7 });
    const jobB = await job(b, "process", 60, { started: 62, finished: 68 });
    const jobC = await job(c, "process", 120, { status: "running", started: 123 });
    await job(d, "process", 180, { status: "queued" });
    // Version 1 at +9, +12, +8 minutes; D has none.
    const versionA = await version(a, 9);
    const versionB = await version(b, 72);
    const versionC = await version(c, 128);
    // One change before B's export; one change after A's export (not counted).
    await job(b, "change", 80, { request: "tighter cut" });
    await job(a, "change", 30, { request: "after export" });
    // Exports at +22, +41, +18 minutes, A first and C last; A exported twice.
    await exported(a, versionA, 22);
    await exported(b, versionB, 101);
    await exported(c, versionC, 138);
    await exported(a, versionA, 40);

    await step(jobA, a, {
      name: "convert",
      status: "done",
      started_at: at(1),
      wall_ms: 1000,
      cpu_ms: 500,
      peak_rss_bytes: 100,
      bytes_in: 10,
      bytes_out: 20,
    });
    await step(jobA, a, {
      name: "decide",
      status: "done",
      started_at: at(2),
      wall_ms: 2000,
      cpu_ms: 1000,
      peak_rss_bytes: 300,
      ai_input_tokens: 100,
      ai_output_tokens: 50,
      ai_cost_usd: 0.25,
      ai_model: "claude-test",
    });
    await step(jobB, b, {
      name: "convert",
      status: "skipped",
      cache_hit: true,
      started_at: at(61),
      wall_ms: 10,
    });
    await step(jobB, b, {
      name: "decide",
      status: "failed",
      started_at: at(62),
      wall_ms: 500,
      cpu_ms: 100,
      peak_rss_bytes: 200,
    });
    await step(jobC, c, { name: "convert", status: "running", started_at: at(121) });

    await stored(a, "upload", "source-a.mp4", 1000);
    await stored(a, "convert", "shared.mp4", 500);
    await stored(b, "convert", "shared.mp4", 500);
    await stored(b, "retime", "retimed-b.mp4", 200);
    await stored(b, "retime", "deleted-b.mp4", 999, true);
  });

  afterAll(async () => {
    await db.query("rollback").catch(() => undefined);
    await db.end();
    if (owner) await deleteTestUser(admin, owner.id);
  });

  it("main metric: upload to first export, 22, 41, 18 minutes in export order", async () => {
    const rows = await run("main-metric");
    expect(rows.map((r) => num(r.minutes))).toEqual([22, 41, 18]);
  });

  it("streak: one reel under 30 minutes since the 41-minute one", async () => {
    expect((await run("main-metric-streak")).map((r) => num(r.streak))).toEqual([1]);
  });

  it("first preview: 9, 12, 8 minutes", async () => {
    const rows = await run("first-preview");
    expect(rows.map((r) => num(r.minutes))).toEqual([9, 12, 8]);
  });

  it("change requests per exported reel: 0, 1, 0 averaged", async () => {
    const rows = await run("changes-per-reel");
    expect(rows).toHaveLength(1);
    expect(num(rows[0]!.changes_per_reel)).toBeCloseTo(1 / 3);
    expect(num(rows[0]!.exported_reels)).toBe(3);
  });

  it("completion: 4 uploaded, 3 exported", async () => {
    const rows = await run("completion");
    expect(rows).toHaveLength(1);
    expect(num(rows[0]!.uploaded_reels)).toBe(4);
    expect(num(rows[0]!.exported_reels)).toBe(3);
    expect(num(rows[0]!.completion)).toBeCloseTo(0.75);
  });

  it("cost per reel: the sums of each reel's steps", async () => {
    const rows = await run("cost-per-reel");
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows;
    expect(first).toMatchObject({ step_runs: "2" });
    expect(num(first!.wall_seconds)).toBe(3);
    expect(num(first!.cpu_seconds)).toBe(1.5);
    expect(num(first!.peak_memory_bytes)).toBe(300);
    expect(num(first!.input_bytes)).toBe(10);
    expect(num(first!.output_bytes)).toBe(20);
    expect(num(first!.ai_tokens_in)).toBe(100);
    expect(num(first!.ai_tokens_out)).toBe(50);
    expect(num(first!.ai_reported_cost_usd)).toBe(0.25);
    expect(num(second!.wall_seconds)).toBe(0.51);
    expect(num(second!.peak_memory_bytes)).toBe(200);
    expect(num(second!.ai_reported_cost_usd)).toBe(0);
    expect(num(third!.wall_seconds)).toBe(0);
  });

  it("cost per step: the sums by step name", async () => {
    const rows = await run("cost-per-step");
    expect(rows.map((r) => [r.step_name, num(r.wall_seconds), num(r.step_runs)])).toEqual([
      ["convert", 1.01, 3],
      ["decide", 2.5, 2],
    ]);
  });

  it("time per step against reel length: done steps by step and 15-second bucket", async () => {
    const rows = await run("step-time-vs-length");
    expect(
      rows.map((r) => [
        r.step_name,
        num(r.source_seconds_from),
        num(r.done_steps),
        num(r.median_seconds),
        num(r.max_seconds),
        num(r.median_seconds_per_footage_second),
      ]),
    ).toEqual([
      ["convert", 15, 1, 1, 1, 1 / 16],
      ["decide", 15, 1, 2, 2, 2 / 16],
    ]);
  });

  it("failed steps: failed over done or failed, by step", async () => {
    const rows = await run("failed-steps");
    expect(
      rows.map((r) => [
        r.step_name,
        num(r.failed_steps),
        num(r.finished_steps),
        num(r.failed_share),
      ]),
    ).toEqual([
      ["convert", 0, 1, 0],
      ["decide", 1, 2, 0.5],
    ]);
  });

  it("storage per reel: live bytes, a shared object counted for each reel", async () => {
    const rows = await run("storage-per-reel");
    expect(rows.map((r) => [num(r.live_bytes), num(r.live_files)])).toEqual([
      [1500, 2],
      [700, 2],
    ]);
  });

  it("storage per step: live bytes by the step that made the file", async () => {
    const rows = await run("storage-per-step");
    expect(rows.map((r) => [r.step_name, num(r.live_bytes)])).toEqual([
      ["convert", 1000],
      ["upload", 1000],
      ["retime", 200],
    ]);
  });

  it("storage total: a shared object once, a deleted one never", async () => {
    const rows = await run("storage-total");
    expect(rows).toHaveLength(1);
    expect(num(rows[0]!.total_bytes)).toBe(1700);
    expect(num(rows[0]!.per_reel_row_bytes)).toBe(2200);
    expect(num(rows[0]!.live_objects)).toBe(3);
  });

  it("jobs per day: every job by kind, one day", async () => {
    const rows = await run("jobs-per-day");
    expect(rows.map((r) => [r.job_kind, num(r.jobs)])).toEqual([
      ["change", 2],
      ["process", 5],
      ["render", 4],
    ]);
  });

  it("job run time: median and 95th percentile of done jobs, by kind", async () => {
    const rows = await run("job-run-time");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job_kind).toBe("process");
    expect(num(rows[0]!.done_jobs)).toBe(2);
    expect(num(rows[0]!.median_minutes)).toBeCloseTo(4.5);
    expect(num(rows[0]!.p95_minutes)).toBeCloseTo(5.85);
  });

  it("queue wait: created to started of claimed jobs, by kind", async () => {
    const rows = await run("queue-wait");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job_kind).toBe("process");
    expect(num(rows[0]!.claimed_jobs)).toBe(4);
    expect(num(rows[0]!.median_wait_minutes)).toBeCloseTo(1.5);
    expect(num(rows[0]!.p95_wait_minutes)).toBeCloseTo(2.85);
  });

  it("worker busy hours: done and failed jobs' run time, by day", async () => {
    const rows = await run("worker-busy-hours");
    expect(rows).toHaveLength(1);
    expect(num(rows[0]!.busy_hours)).toBeCloseTo(10 / 60);
    expect(num(rows[0]!.busy_share)).toBeCloseTo(10 / 60 / 24);
    expect(num(rows[0]!.finished_jobs)).toBe(3);
  });

  it("share of worker time waiting on Claude: AI steps' wall time over all", async () => {
    const rows = await run("ai-wait-share");
    expect(rows).toHaveLength(1);
    expect(num(rows[0]!.ai_wall_seconds)).toBe(2);
    expect(num(rows[0]!.wall_seconds)).toBe(3.51);
    expect(num(rows[0]!.ai_share)).toBeCloseTo(2000 / 3510);
  });

  it("capacity: CPU seconds per source minute and peak memory, done steps", async () => {
    const rows = await run("capacity-per-minute");
    expect(
      rows.map((r) => [
        r.step_name,
        num(r.done_steps),
        num(r.median_cpu_seconds_per_source_minute),
        num(r.max_peak_memory_bytes),
      ]),
    ).toEqual([
      ["convert", 1, 1.5, 100],
      ["decide", 1, 3, 300],
    ]);
  });

  it("cache hit rate: hits over done, failed or skipped steps", async () => {
    const rows = await run("cache-hit-rate");
    expect(rows).toHaveLength(1);
    expect(num(rows[0]!.cache_hits)).toBe(1);
    expect(num(rows[0]!.finished_steps)).toBe(4);
    expect(num(rows[0]!.hit_rate)).toBe(0.25);
    expect(num(rows[0]!.hit_rate_to_date)).toBe(0.25);
  });
});
