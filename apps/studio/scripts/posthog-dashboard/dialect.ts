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
  /** Seconds from `from` to `to`. */
  secondsBetween(from: string, to: string): string;
  /** The midnight that starts the day of `ts`. */
  dayOf(ts: string): string;
  /** The median of `expr` over the group. */
  median(expr: string): string;
  /** The `level` quantile (0 to 1) of `expr` over the group. */
  quantile(level: number, expr: string): string;
}

export const hogql: Dialect = {
  name: "hogql",
  minutesBetween: (from, to) => `dateDiff('second', ${from}, ${to}) / 60.0`,
  weekOf: (ts) => `toStartOfWeek(${ts}, 1)`,
  secondsBetween: (from, to) => `dateDiff('second', ${from}, ${to})`,
  dayOf: (ts) => `toStartOfDay(${ts})`,
  median: (expr) => `median(${expr})`,
  quantile: (level, expr) => `quantile(${level})(${expr})`,
};

export const postgres: Dialect = {
  name: "postgres",
  minutesBetween: (from, to) => `extract(epoch from (${to} - ${from})) / 60.0`,
  weekOf: (ts) => `date_trunc('week', ${ts})`,
  secondsBetween: (from, to) => `extract(epoch from (${to} - ${from}))`,
  dayOf: (ts) => `date_trunc('day', ${ts})`,
  median: (expr) => `percentile_cont(0.5) within group (order by ${expr})`,
  quantile: (level, expr) => `percentile_cont(${level}) within group (order by ${expr})`,
};

/** Resolves a synced table's bare name to its reference in the target database. */
export type TableRef = (name: string) => string;
