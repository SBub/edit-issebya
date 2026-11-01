import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkMigrationVersions, MIGRATION_CLOCK_SKEW_MS } from "./migration-versions";

const now = new Date("2026-11-01T12:00:00Z");

const file = (version: string, slug: string) => `${version}_${slug}.sql`;

const clean = [
  file("20261031105245", "studio_skeleton"),
  file("20261031174750", "job_queue"),
  file("20261101090000", "step_measurements"),
  file("20261101100000", "pipeline_steps"),
];

describe("checkMigrationVersions", () => {
  it("accepts a clean list", () => {
    expect(checkMigrationVersions(clean, now)).toEqual([]);
  });

  it("reports a future-dated version", () => {
    const problems = checkMigrationVersions([...clean, "20991231000000_probe.sql"], now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("20991231000000_probe.sql");
    expect(problems[0]).toContain("future");
  });

  it("allows 10 minutes of clock skew and no more", () => {
    expect(MIGRATION_CLOCK_SKEW_MS).toBe(10 * 60 * 1000);
    expect(checkMigrationVersions(["20261101120900_skew.sql"], now)).toEqual([]);
    expect(checkMigrationVersions(["20261101121100_skew.sql"], now)).toHaveLength(1);
  });

  it("reports a version two files share", () => {
    const problems = checkMigrationVersions(["20261101090000_b.sql", "20261101090000_a.sql"], now);
    expect(problems).toEqual([
      "20261101090000 is used by 20261101090000_a.sql, 20261101090000_b.sql",
    ]);
  });

  it("reports a missing prefix and an impossible date", () => {
    const problems = checkMigrationVersions(["probe.sql", "20261301000000_bad.sql"], now);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("probe.sql");
    expect(problems[0]).toContain("no 14-digit");
    expect(problems[1]).toContain("20261301000000_bad.sql");
    expect(problems[1]).toContain("not a valid UTC timestamp");
  });

  it("ignores files that are not SQL", () => {
    expect(checkMigrationVersions([".gitkeep", ...clean], now)).toEqual([]);
  });

  it("reports a pipeline_steps file a day ahead, as before the rename", () => {
    const unfixed = [...clean.slice(0, 3), file("20261102120000", "pipeline_steps")];
    const problems = checkMigrationVersions(unfixed, now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("20261102120000_pipeline_steps.sql");
  });
});

describe("supabase/migrations", () => {
  it("has no future-dated, duplicate or malformed version", () => {
    const dir = new URL("../../../supabase/migrations/", import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed migrations folder
    const names = readdirSync(dir);
    expect(names.filter((name) => name.endsWith(".sql")).length).toBeGreaterThan(0);
    expect(checkMigrationVersions(names, new Date())).toEqual([]);
  });
});
