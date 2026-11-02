import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every handled failure in the studio's server code goes through
// reportFailure (src/lib/error-tracking.ts), which logs and captures it, so a
// new one cannot log without reaching PostHog. Client components
// (src/components/) are out of scope: uncaught browser errors reach PostHog
// through capture_exceptions.
const SRC = new URL("..", import.meta.url).pathname;

function serverFiles(dir: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- folders under src/
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return serverFiles(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    if (entry.name === "error-tracking.ts") return [];
    return [path];
  });
}

describe("studio server failures", () => {
  it("never call console.error directly", () => {
    const files = [...serverFiles(join(SRC, "app")), ...serverFiles(join(SRC, "lib"))];
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- files under src/
      .filter((file) => readFileSync(file, "utf8").includes("console.error("))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
