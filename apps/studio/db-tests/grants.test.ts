import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDbUrl } from "../test-support/local-supabase.ts";

// The hosted project grants anon, authenticated and service_role no data
// privilege on a new public table by default, so every table needs explicit
// grants per role. The local stack is cut down to the same defaults
// (migration service_role_table_grants); these tests keep it that way.

const DATA = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const ROLES = ["anon", "authenticated", "service_role"];

let db: pg.Client;

beforeAll(async () => {
  db = new pg.Client({ connectionString: localDbUrl() });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

async function publicTables(): Promise<string[]> {
  const { rows } = await db.query<{ table: string }>(`
    select c.relname as table
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`);
  return rows.map((r) => r.table);
}

// Table-level privileges a role holds on a public table (column grants are
// not counted).
async function tablePrivileges(role: string, table: string): Promise<string[]> {
  const { rows } = await db.query<{ privilege: string }>(
    `select a.privilege_type as privilege
     from pg_class c join pg_namespace n on n.oid = c.relnamespace,
          aclexplode(c.relacl) a
     where n.nspname = 'public' and c.relname = $2 and a.grantee = $1::regrole
     order by 1`,
    [role, table],
  );
  return rows.map((r) => r.privilege);
}

describe("public table grants", () => {
  it("gives service_role select, insert, update and delete on every public table", async () => {
    const tables = await publicTables();
    // Not vacuous: the list holds at least the studio's tables.
    expect(tables).toEqual(
      expect.arrayContaining([
        "reels",
        "jobs",
        "steps",
        "versions",
        "exports",
        "stored_files",
        "worker_status",
      ]),
    );
    for (const table of tables) {
      const held = await tablePrivileges("service_role", table);
      expect({ table, held }).toEqual({ table, held: expect.arrayContaining(DATA) });
    }
  });

  it("gives anon nothing on any public table", async () => {
    for (const table of await publicTables()) {
      expect({ table, held: await tablePrivileges("anon", table) }).toEqual({ table, held: [] });
    }
  });

  it("never gives authenticated table-wide insert, update or delete", async () => {
    for (const table of await publicTables()) {
      const held = await tablePrivileges("authenticated", table);
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        expect({ table, privilege, held: held.includes(privilege) }).toEqual({
          table,
          privilege,
          held: false,
        });
      }
    }
  });
});

describe("public default privileges (as on hosted)", () => {
  it("grant anon, authenticated and service_role no data privilege on new tables", async () => {
    const { rows } = await db.query<{ grantee: string; privilege: string }>(`
      select a.grantee::regrole::text as grantee, a.privilege_type as privilege
      from pg_default_acl d, aclexplode(d.defaclacl) a
      where d.defaclrole = 'postgres'::regrole
        and d.defaclnamespace = 'public'::regnamespace
        and d.defaclobjtype = 'r'`);
    // Not vacuous: postgres's own entry is there.
    expect(rows.some((r) => r.grantee === "postgres" && r.privilege === "SELECT")).toBe(true);
    const leaked = rows.filter((r) => ROLES.includes(r.grantee) && DATA.includes(r.privilege));
    expect(leaked).toEqual([]);
  });

  it("grant anon, authenticated and service_role nothing on new sequences or functions", async () => {
    const { rows } = await db.query<{ kind: string; grantee: string; privilege: string }>(`
      select d.defaclobjtype::text as kind, a.grantee::regrole::text as grantee,
             a.privilege_type as privilege
      from pg_default_acl d, aclexplode(d.defaclacl) a
      where d.defaclrole = 'postgres'::regrole
        and d.defaclnamespace = 'public'::regnamespace
        and d.defaclobjtype in ('S', 'f')`);
    expect(rows.filter((r) => ROLES.includes(r.grantee))).toEqual([]);
  });

  it("leave a new table unreadable by service_role until it is granted", async () => {
    await db.query("begin");
    try {
      await db.query("create table public.grants_probe (id int)");
      const { rows } = await db.query<{ can: boolean }>(
        `select has_table_privilege('service_role', 'public.grants_probe', 'select') as can`,
      );
      expect(rows[0]?.can).toBe(false);
    } finally {
      await db.query("rollback");
    }
  });
});
