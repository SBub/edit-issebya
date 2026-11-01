import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Node 24 runs @edit-issebya/edit's TypeScript source with no build step: it
// resolves the workspace link to its real path under packages/edit/, outside
// node_modules, where type stripping applies (as for @edit-issebya/storage).
it("imports the edit package in plain Node and builds the fixture baseline", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const script = `
    import { readFileSync } from "node:fs";
    import { ISSEBYA, baselineEdit, build, createMeasurer } from "@edit-issebya/edit";
    const read = (file) => readFileSync(new URL(import.meta.resolve("@edit-issebya/edit/assets/" + file)));
    const transcript = JSON.parse(readFileSync("../../fixtures/pipeline/retime/transcript.json", "utf8"));
    const headTrack = JSON.parse(readFileSync("../../fixtures/pipeline/head_track/head-track.json", "utf8"));
    const fp = "0".repeat(64);
    const edit = baselineEdit(transcript, { footage: fp, transcript: fp, cutout: fp, headTrack: fp }, ISSEBYA);
    const measurer = createMeasurer({ primary: read(ISSEBYA.fonts.primary.file), secondary: read(ISSEBYA.fonts.secondary.file) });
    console.log(build({ edit, transcript, headTrack, preset: ISSEBYA, measurer }).html.length);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(Number(result.stdout.trim())).toBeGreaterThan(1000);
});
