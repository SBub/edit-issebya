import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFootage, footageRefusal, storedFacts } from "./check-footage.ts";
import { fingerprintsFor } from "./definition.ts";

// fixtures/footage-check/ is what the E2E refusal spec seeds: a refused clip
// and its footage check facts under their fingerprint, so CI needs no ffprobe.
// A check_footage version or setting change fails here until
// `fixtures:pipeline` runs.
const REPOSITORY = new URL("../../../../", import.meta.url);
const read = (path: string) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  readFileSync(new URL(path, REPOSITORY));
const manifest = JSON.parse(read("fixtures/footage-check/manifest.json").toString("utf8")) as {
  clips: {
    file: string;
    source: { etag: string; bytes: number };
    fingerprint: string;
    files: string[];
    refusal: string;
  }[];
};

describe("fixtures/footage-check", () => {
  it("lists the landscape clip", () => {
    expect(manifest.clips.map((clip) => clip.file)).toEqual(["landscape.mp4"]);
  });

  for (const clip of manifest.clips) {
    const name = clip.file.replace(/\.mp4$/, "");

    it(`${clip.file}: was made from the committed clip`, () => {
      const bytes = read(`fixtures/footage-check/${clip.file}`);
      expect(clip.source).toEqual({
        etag: createHash("md5").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    });

    it(`${clip.file}: carries the fingerprint the definition computes now`, () => {
      expect(clip.fingerprint).toBe(fingerprintsFor(clip.source, [checkFootage]).check_footage);
      expect(clip.files).toEqual(["footage.json"]);
    });

    it(`${clip.file}: its committed facts give the recorded refusal`, () => {
      const facts = storedFacts(read(`fixtures/footage-check/${name}/footage.json`));
      expect(footageRefusal(facts)).toBe(clip.refusal);
      expect(clip.refusal).toMatch(/landscape/);
    });
  }
});
