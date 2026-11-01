import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The worker runs TypeScript with plain Node 24 and packages/edit has no build
// step: Node strips the package's types because its workspace symlink resolves
// outside node_modules. This keeps that a tested fact.
describe("@edit-issebya/edit under plain Node", () => {
  it("imports the package's TypeScript source", () => {
    const script =
      "const m = await import('@edit-issebya/edit'); if (typeof m.build !== 'function') process.exit(2);";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
