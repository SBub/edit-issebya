import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNCED_TABLES } from "../scripts/posthog-dashboard/config.ts";
import { createTestUser, deleteTestUser, insertReel } from "../test-support/fixtures.ts";
import { localDbUrl, localSupabaseAdmin } from "../test-support/local-supabase.ts";

// Every table the PostHog Postgres source syncs has an `updated_at` column
// moved by public.set_updated_at() on every update, so the sync can be
// incremental (app_docs/dashboard.md). Versions and exports stay immutable.

const admin = localSupabaseAdmin();
const db = new pg.Client({ connectionString: localDbUrl() });
let owner: { id: string; email: string };
let reelId: string;
const ids: Record<string, string> = {};

async function updatedAt(table: string, id: string): Promise<Date> {
  // The table name comes from the fixed list above, never from input.
  const { rows } = await db.query<{ updated_at: Date }>(
    `select updated_at from public.${table} where id = $1`,
    [id],
  );
  return rows[0]!.updated_at;
}

beforeAll(async () => {
  await db.connect();
  owner = await createTestUser(admin, "sync-columns");
  reelId = await insertReel(admin, { ownerId: owner.id, status: "processed" });
  ids.reels = reelId;
  const job = await db.query<{ id: string }>(
    `insert into public.jobs (reel_id, owner_id, status) values ($1, $2, 'done') returning id`,
    [reelId, owner.id],
  );
  ids.jobs = job.rows[0]!.id;
  const step = await db.query<{ id: string }>(
    `insert into public.steps (job_id, reel_id, owner_id, name, status)
     values ($1, $2, $3, 'convert', 'done') returning id`,
    [ids.jobs, reelId, owner.id],
  );
  ids.steps = step.rows[0]!.id;
  ids.versions = randomUUID();
  await db.query(
    `insert into public.versions (id, reel_id, owner_id, number, inputs, r2_key)
     values ($1, $2, $3, 1, '{}'::jsonb, $4)`,
    [ids.versions, reelId, owner.id, `sync-columns/${ids.versions}.json`],
  );
  const render = await db.query<{ id: string }>(
    `insert into public.jobs (reel_id, owner_id, kind, status, version_id)
     values ($1, $2, 'render', 'done', $3) returning id`,
    [reelId, owner.id, ids.versions],
  );
  ids.exports = randomUUID();
  await db.query(
    `insert into public.exports (id, reel_id, owner_id, job_id, version_id, r2_key, bytes)
     values ($1, $2, $3, $4, $5, $6, 10)`,
    [
      ids.exports,
      reelId,
      owner.id,
      render.rows[0]!.id,
      ids.versions,
      `sync-columns/${ids.exports}.mp4`,
    ],
  );
  const stored = await db.query<{ id: string }>(
    `insert into public.stored_files (reel_id, owner_id, step, r2_key, bytes, kind)
     values ($1, $2, 'convert', $3, 10, 'rebuildable') returning id`,
    [reelId, owner.id, `sync-columns/${randomUUID()}.mp4`],
  );
  ids.stored_files = stored.rows[0]!.id;
});

afterAll(async () => {
  if (owner) await deleteTestUser(admin, owner.id);
  await db.end();
});

describe("synced tables", () => {
  it("are exactly the six the dashboard reads", () => {
    expect([...SYNCED_TABLES]).toEqual([
      "reels",
      "jobs",
      "steps",
      "versions",
      "exports",
      "stored_files",
    ]);
  });

  it.each(SYNCED_TABLES)("%s has updated_at timestamptz not null default now()", async (table) => {
    const { rows } = await db.query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = 'updated_at'`,
      [table],
    );
    expect(rows).toEqual([
      { data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
  });

  it.each(SYNCED_TABLES)(
    "%s moves updated_at through set_updated_at before each update",
    async (table) => {
      const { rows } = await db.query<{ def: string }>(
        `select pg_get_triggerdef(t.oid) as def
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       join pg_namespace pn on pn.oid = p.pronamespace
       where n.nspname = 'public' and c.relname = $1 and not t.tgisinternal
         and p.proname = 'set_updated_at' and pn.nspname = 'public'`,
        [table],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.def).toContain(`${table}_set_updated_at BEFORE UPDATE ON public.${table}`);
      expect(rows[0]!.def).toContain("FOR EACH ROW EXECUTE FUNCTION set_updated_at()");
    },
  );
});

describe("updated_at", () => {
  it("is set on insert", async () => {
    const { rows } = await db.query<{ now: Date }>("select now() as now");
    for (const table of SYNCED_TABLES) {
      const value = await updatedAt(table, ids[table]!);
      expect(Math.abs(rows[0]!.now.getTime() - value.getTime())).toBeLessThan(60_000);
    }
  });

  // One autocommit statement each: now() is the transaction's time.
  it.each([
    ["reels", "update public.reels set source_name = 'renamed.mov' where id = $1"],
    ["jobs", "update public.jobs set error_tail = 'tail' where id = $1"],
    ["steps", "update public.steps set summary = 'converted' where id = $1"],
    ["stored_files", "update public.stored_files set deleted_at = now() where id = $1"],
  ])("moves on an update of %s", async (table, statement) => {
    const before = await updatedAt(table, ids[table]!);
    await db.query("select pg_sleep(0.02)");
    await db.query(statement, [ids[table]]);
    expect((await updatedAt(table, ids[table]!)).getTime()).toBeGreaterThan(before.getTime());
  });

  it.each([
    ["versions", "update public.versions set change_summary = 'x' where id = $1"],
    ["exports", "update public.exports set bytes = 11 where id = $1"],
  ])("stays the insert time on %s, still immutable", async (table, statement) => {
    const before = await updatedAt(table, ids[table]!);
    await expect(db.query(statement, [ids[table]])).rejects.toMatchObject({ code: "55000" });
    expect((await updatedAt(table, ids[table]!)).getTime()).toBe(before.getTime());
  });
});
