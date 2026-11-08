import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The owner's rule (AGENTS.md): the repository is public and the prompt wording
// is private, so no prompt text lives in it. The prompts are fetched from PostHog
// by name; tests use the placeholders in apps/worker/test-support.
const RULE =
  "prompt wording lives only in PostHog prompt management, never in the repo (AGENTS.md): no prompt .md file here; tests use placeholder prompts (apps/worker/test-support/fake-prompts.ts)";

const APPS = fileURLToPath(new URL("../../../", import.meta.url));
const WORKER_SRC = fileURLToPath(new URL("../", import.meta.url));
const PROMPT_DIRS = ["decide", "photos"].map((dir) => join(WORKER_SRC, dir));
const SKIPPED = new Set(["node_modules", "dist", "build"]);

// Every file under a folder, skipping dependencies, build output and dot folders.
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the repository's own folders
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED.has(entry.name) || entry.name.startsWith(".next")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

describe("no prompt text in the repository", () => {
  it("has no Markdown file under apps/worker/src/decide or apps/worker/src/photos", () => {
    const offenders = PROMPT_DIRS.flatMap(filesUnder)
      .filter((path) => path.endsWith(".md"))
      .map((path) => path.slice(APPS.length));
    expect(offenders, RULE).toEqual([]);
  });

  it("has no file named like a prompt, *prompt*.md, anywhere under apps/", () => {
    const offenders = filesUnder(APPS)
      .filter((path) => /prompt.*\.md$/i.test(path))
      .map((path) => path.slice(APPS.length));
    expect(offenders, RULE).toEqual([]);
  });
});
