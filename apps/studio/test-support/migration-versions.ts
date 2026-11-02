// Guard for supabase/migrations: every version must be a real UTC timestamp, not later than now
// (plus a small clock-skew allowance) and used by one file only. Supabase applies migrations in
// version order, so a future-dated version sorts after every migration written before its time.

export const MIGRATION_CLOCK_SKEW_MS = 10 * 60 * 1000;

const VERSION_PATTERN = /^(\d{14})_.+\.sql$/;

function parseVersion(version: string): number | null {
  const y = Number(version.slice(0, 4));
  const mo = Number(version.slice(4, 6));
  const d = Number(version.slice(6, 8));
  const h = Number(version.slice(8, 10));
  const mi = Number(version.slice(10, 12));
  const s = Number(version.slice(12, 14));
  const time = Date.UTC(y, mo - 1, d, h, mi, s);
  const date = new Date(time);
  const roundTrip =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s;
  return roundTrip ? time : null;
}

export function checkMigrationVersions(fileNames: readonly string[], now: Date): string[] {
  const problems: string[] = [];
  const byVersion = new Map<string, string[]>();
  const limit = now.getTime() + MIGRATION_CLOCK_SKEW_MS;

  for (const name of fileNames) {
    if (!name.endsWith(".sql")) continue;
    const version = VERSION_PATTERN.exec(name)?.[1];
    if (version === undefined) {
      problems.push(`${name}: no 14-digit UTC version prefix`);
      continue;
    }
    const time = parseVersion(version);
    if (time === null) {
      problems.push(`${name}: ${version} is not a valid UTC timestamp`);
    } else if (time > limit) {
      problems.push(
        `${name}: version ${version} is in the future (now ${now.toISOString()}); create migrations with supabase migration new`,
      );
    }
    byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
  }

  for (const [version, names] of byVersion) {
    if (names.length > 1) {
      problems.push(`${version} is used by ${[...names].sort().join(", ")}`);
    }
  }

  return problems;
}
