import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PIPELINE, fingerprintsFor } from "./definition.ts";

// fixtures/pipeline/ is what the E2E upload spec seeds so every step is a hit.
// A step version or setting change fails here until `fixtures:pipeline` runs.
const REPOSITORY = new URL("../../../../", import.meta.url);
const read = (path: string) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  readFileSync(new URL(path, REPOSITORY));
const manifest = JSON.parse(read("fixtures/pipeline/manifest.json").toString("utf8")) as {
  source: { etag: string; bytes: number };
  steps: { name: string; fingerprint: string; files: string[] }[];
};

describe("fixtures/pipeline", () => {
  it("were made from the committed clip", () => {
    const clip = read("fixtures/footage/short-speech.mp4");
    expect(manifest.source).toEqual({
      etag: createHash("md5").update(clip).digest("hex"),
      bytes: clip.length,
    });
  });

  it("carry the fingerprints the definition computes now", () => {
    const fingerprints = fingerprintsFor(manifest.source);
    expect(manifest.steps).toEqual(
      PIPELINE.map((step) => ({
        name: step.name,
        fingerprint: fingerprints[step.name],
        files: step.outputs.map((output) => output.file),
      })),
    );
  });

  it("hold every listed file", () => {
    for (const step of manifest.steps) {
      for (const file of step.files) {
        expect(
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
          existsSync(new URL(`fixtures/pipeline/${step.name}/${file}`, REPOSITORY)),
          file,
        ).toBe(true);
      }
    }
  });
});
