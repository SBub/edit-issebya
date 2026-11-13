import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE EVAL BOUNDARY (app_docs/evals.md, "The snapshot"): the judge and curator
// evals read the dataset items only. Nothing they load at run time may reach the
// app's database or storage. Only the snapshot command may: `eval-snapshot.ts`
// and the adapters it wires (`evals/worker-sources.ts`).

const SRC = dirname(fileURLToPath(import.meta.url));

// The eval entries: the judge and curator commands, and every eval module.
const ENTRIES = [
  join(SRC, "eval-judge.ts"),
  join(SRC, "eval-curator.ts"),
  ...readdirSync(join(SRC, "evals"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => name !== "worker-sources.ts")
    .map((name) => join(SRC, "evals", name)),
];

// Modules the eval code must never load: the database client, the storage and
// its adapters, the app's own DB and R2 wiring, and the snapshot command.
const FORBIDDEN_PACKAGES = ["@supabase/supabase-js", "@edit-issebya/storage", "@aws-sdk/"];
const FORBIDDEN_FILES = [
  join(SRC, "supabase.ts"),
  join(SRC, "storage.ts"),
  join(SRC, "evals", "worker-sources.ts"),
  join(SRC, "eval-snapshot.ts"),
];

// Every import and re-export: its module specifier, and whether it is type-only
// (erased at compile time, so it loads nothing at run time).
function importsOf(file: string): { from: string; typeOnly: boolean }[] {
  /* eslint-disable-next-line security/detect-non-literal-fs-filename -- the repository's own sources */
  const source = readFileSync(file, "utf8");
  const found: { from: string; typeOnly: boolean }[] = [];
  // Each `from "<module>"`, typed when the statement it closes starts `import type` or `export type`.
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    const head = source.slice(0, match.index);
    const start = Math.max(head.lastIndexOf("import "), head.lastIndexOf("export "));
    const typeOnly = /^(import|export) type /.test(head.slice(start));
    found.push({ from: match[1]!, typeOnly });
  }
  const bare = /\bimport\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(bare)) found.push({ from: match[1]!, typeOnly: false });
  const dynamic = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamic)) found.push({ from: match[1]!, typeOnly: false });
  return found;
}

function forbidden(from: string, resolved: string | null): string | null {
  if (resolved && FORBIDDEN_FILES.includes(resolved)) return resolved;
  if (!resolved) {
    return FORBIDDEN_PACKAGES.find((name) => from === name || from.startsWith(name)) ?? null;
  }
  return null;
}

// The runtime import chain from one entry to a forbidden module, or null.
// Type-only imports are followed for the entry's own imports (they must not name
// a forbidden module) but not further: they load nothing.
function violationFrom(entry: string): string | null {
  const seen = new Set<string>([entry]);
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }];
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    for (const { from, typeOnly } of importsOf(file)) {
      const resolved = from.startsWith(".") ? resolve(dirname(file), from) : null;
      const hit = forbidden(from, resolved);
      if (hit && (!typeOnly || file === entry)) {
        return [...chain, from].map((step) => step.replace(`${SRC}/`, "src/")).join(" -> ");
      }
      if (resolved && !typeOnly && !seen.has(resolved) && resolved.startsWith(SRC)) {
        seen.add(resolved);
        queue.push({ file: resolved, chain: [...chain, resolved] });
      }
    }
  }
  return null;
}

describe("the eval modules' boundary", () => {
  it("the eval entries are the judge, the curator and their modules", () => {
    expect(ENTRIES.length).toBeGreaterThan(10);
    expect(ENTRIES.map((file) => file.replace(`${SRC}/`, ""))).toContain("eval-judge.ts");
  });

  it.each(ENTRIES.map((file) => [file.replace(`${SRC}/`, ""), file]))(
    "%s loads nothing from the app's database or storage",
    (_name, file) => {
      expect(violationFrom(file)).toBeNull();
    },
  );

  it("only the snapshot command wires the database and storage adapters", () => {
    const wiring = readFileSync(join(SRC, "eval-snapshot.ts"), "utf8");
    expect(wiring).toContain("workerCuratorSources");
    for (const file of ENTRIES) {
      expect(importsOf(file).map((one) => one.from)).not.toContain("./eval-snapshot.ts");
    }
  });
});
