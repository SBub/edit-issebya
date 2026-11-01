import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { previewKeys } from "./preview-sources";

const manifest = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture manifest
  readFileSync(new URL("../../../../fixtures/pipeline/manifest.json", import.meta.url), "utf8"),
) as { steps: { name: string; fingerprint: string }[] };
const fp = (step: string) => manifest.steps.find((entry) => entry.name === step)!.fingerprint;

const REEL = "5f1c9e2a-0d3b-4a7e-8c6f-2b9d4e1a7c30";
const VERSION = "0b6f2a52-7d0e-4c55-9d4a-3c1f0e8a1b01";
const INPUTS = { transcript: fp("retime"), headTrack: fp("head_track") };

describe("previewKeys", () => {
  it("names the version, its transcript and head track, and the preview copies", () => {
    const keys = previewKeys({
      reelId: REEL,
      version: {
        id: VERSION,
        r2_key: `e2e-x/reels/${REEL}/versions/${VERSION}.json`,
        inputs: INPUTS,
      },
      previewFingerprint: fp("preview_copies"),
    });
    expect(keys).toEqual({
      version: `e2e-x/reels/${REEL}/versions/${VERSION}.json`,
      transcript: `e2e-x/cache/retime/${fp("retime")}/transcript.json`,
      headTrack: `e2e-x/cache/head_track/${fp("head_track")}/head-track.json`,
      footage: `e2e-x/cache/preview_copies/${fp("preview_copies")}/footage.mp4`,
      cutout: `e2e-x/cache/preview_copies/${fp("preview_copies")}/subject.webm`,
    });
  });

  it("works with no prefix", () => {
    const keys = previewKeys({
      reelId: REEL,
      version: { id: VERSION, r2_key: `reels/${REEL}/versions/${VERSION}.json`, inputs: INPUTS },
      previewFingerprint: fp("preview_copies"),
    });
    expect(keys.transcript).toBe(`cache/retime/${fp("retime")}/transcript.json`);
  });

  it("refuses a version key of another reel or version", () => {
    expect(() =>
      previewKeys({
        reelId: REEL,
        version: { id: VERSION, r2_key: `reels/other/versions/${VERSION}.json`, inputs: INPUTS },
        previewFingerprint: "c",
      }),
    ).toThrow("unexpected version key");
  });

  it("refuses a key that could leave the store", () => {
    expect(() =>
      previewKeys({
        reelId: REEL,
        version: {
          id: VERSION,
          r2_key: `../reels/${REEL}/versions/${VERSION}.json`,
          inputs: INPUTS,
        },
        previewFingerprint: "c",
      }),
    ).toThrow("invalid storage key");
    expect(() =>
      previewKeys({
        reelId: REEL,
        version: {
          id: VERSION,
          r2_key: `reels/${REEL}/versions/${VERSION}.json`,
          inputs: { transcript: "..", headTrack: "b" },
        },
        previewFingerprint: "c",
      }),
    ).toThrow("invalid storage key");
  });
});
