import { SYNCED_TABLES, type SyncedTable } from "./config.ts";

// What a rendered query reads, for the tests: every `<table>.<column>` pair of
// a synced table (each query aliases a synced table by its bare name and
// qualifies every column) and every `event = '...'` name.

function isSynced(name: string): name is SyncedTable {
  return (SYNCED_TABLES as readonly string[]).includes(name);
}

export function columnReferences(sql: string): [SyncedTable, string][] {
  const pairs = new Map<string, [SyncedTable, string]>();
  for (const match of sql.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)) {
    const [, table = "", column = ""] = match;
    if (isSynced(table)) pairs.set(`${table}.${column}`, [table, column]);
  }
  return [...pairs.values()];
}

export function eventNames(sql: string): string[] {
  return [...sql.matchAll(/\bevent\s*=\s*'([^']+)'/g)].map((match) => match[1] ?? "");
}
