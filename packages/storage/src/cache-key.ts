import { assertStorageKey } from "./storage.ts";

// Where a pipeline step's output lives: `${prefix}cache/<step>/<fingerprint>/<file>`.
// The worker writes there and the studio's preview reads from there.
export function cacheKey(prefix: string, step: string, fp: string, file: string): string {
  return assertStorageKey(`${prefix}cache/${step}/${fp}/${file}`);
}
