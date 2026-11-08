import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PIPELINE, fingerprintsFor, outputFiles } from "./definition.ts";

// fixtures/pipeline/ is what the E2E specs seed so every step is a hit. Each
// committed clip's outputs sit in their own folder: short-speech's at the top,
// the others in a folder named after the clip (speech-ten/). A step version or
// setting change fails here until `fixtures:pipeline` runs.
const REPOSITORY = new URL("../../../../", import.meta.url);
const read = (path: string) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  readFileSync(new URL(path, REPOSITORY));

const CLIPS = [
  { clip: "short-speech", folder: "fixtures/pipeline/" },
  { clip: "speech-ten", folder: "fixtures/pipeline/speech-ten/" },
];

describe.each(CLIPS)("fixtures/pipeline for $clip", ({ clip, folder }) => {
  const manifest = JSON.parse(read(`${folder}manifest.json`).toString("utf8")) as {
    source: { etag: string; bytes: number };
    steps: { name: string; fingerprint: string; files: string[] }[];
  };

  it("were made from the committed clip", () => {
    const bytes = read(`fixtures/footage/${clip}.mp4`);
    expect(manifest.source).toEqual({
      etag: createHash("md5").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  });

  it("carry the fingerprints the definition computes now", () => {
    const fingerprints = fingerprintsFor(manifest.source);
    expect(manifest.steps).toEqual(
      PIPELINE.map((step) => ({
        name: step.name,
        fingerprint: fingerprints[step.name],
        files: outputFiles(step),
      })),
    );
  });

  it("hold every listed file", () => {
    for (const step of manifest.steps) {
      for (const file of step.files) {
        expect(
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
          existsSync(new URL(`${folder}${step.name}/${file}`, REPOSITORY)),
          file,
        ).toBe(true);
      }
    }
  });
});
