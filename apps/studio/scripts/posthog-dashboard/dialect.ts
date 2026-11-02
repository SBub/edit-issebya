// One SQL text, two dialects. Each insight's query is written in a subset that
// both PostHog's HogQL (ClickHouse-flavoured) and Postgres accept: CTEs,
// `case when`, window functions, `coalesce`, `* 1.0` before a division,
// `sum(case ...)` instead of `countIf`. The few pieces that differ come from
// here. The payload uses `hogql`; db-tests/dashboard-queries.test.ts runs the
// `postgres` rendering of the same query against seeded local rows.

export interface Dialect {
  name: "hogql" | "postgres";
  /** Minutes from `from` to `to`, fractional. */
  minutesBetween(from: string, to: string): string;
  /** The Monday that starts the week of `ts`. */
  weekOf(ts: string): string;
}

export const hogql: Dialect = {
  name: "hogql",
  minutesBetween: (from, to) => `dateDiff('second', ${from}, ${to}) / 60.0`,
  weekOf: (ts) => `toStartOfWeek(${ts}, 1)`,
};

export const postgres: Dialect = {
  name: "postgres",
  minutesBetween: (from, to) => `extract(epoch from (${to} - ${from})) / 60.0`,
  weekOf: (ts) => `date_trunc('week', ${ts})`,
};

/** Resolves a synced table's bare name to its reference in the target database. */
export type TableRef = (name: string) => string;
