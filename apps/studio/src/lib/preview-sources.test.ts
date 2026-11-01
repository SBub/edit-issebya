import type { EditInputs } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import manifest from "../../../../fixtures/pipeline/manifest.json" with { type: "json" };
import { cachePrefixOf, parsePreviewCopies, previewKeys } from "./preview-sources";

const REEL = "3f0c2a8e-1b2d-4c3e-8f4a-5b6c7d8e9f01";
const VERSION = "9d7c1f5e-3a2b-4c6d-8e9f-0a1b2c3d4e5f";

function fp(name: string): string {
  const step = manifest.steps.find((entry) => entry.name === name);
  if (!step) throw new Error(`no ${name} in the manifest`);
  return step.fingerprint;
}

const INPUTS: EditInputs = {
  footage: { step: "retime", fingerprint: fp("retime"), file: "source.mp4" },
  transcript: { step: "retime", fingerprint: fp("retime"), file: "transcript.json" },
  cutout: { step: "remove_background", fingerprint: fp("remove_background"), file: "subject.webm" },
  head_track: { step: "head_track", fingerprint: fp("head_track"), file: "head-track.json" },
};

const COPIES = {
  footage: {
    step: "preview_copies",
    fingerprint: fp("preview_copies"),
    file: "footage-preview.mp4",
  },
  cutout: {
    step: "preview_copies",
    fingerprint: fp("preview_copies"),
    file: "subject-preview.webm",
  },
};

function key(prefix: string): string {
  return `${prefix}reels/${REEL}/versions/${VERSION}.json`;
}

describe("cachePrefixOf", () => {
  it("strips the version suffix, empty or nested prefix", () => {
    expect(cachePrefixOf(key(""), REEL, VERSION)).toBe("");
    expect(cachePrefixOf(key("dev/"), REEL, VERSION)).toBe("dev/");
    expect(cachePrefixOf(key("e2e/run-1/"), REEL, VERSION)).toBe("e2e/run-1/");
  });

  it("refuses a key of another reel or version", () => {
    expect(cachePrefixOf(key("dev/"), VERSION, REEL)).toBeNull();
    expect(cachePrefixOf(`dev/reels/${REEL}/source/original.mp4`, REEL, VERSION)).toBeNull();
  });

  it("refuses a malformed prefix", () => {
    expect(cachePrefixOf(key("dev"), REEL, VERSION)).toBeNull();
    expect(cachePrefixOf(key("Dev/"), REEL, VERSION)).toBeNull();
  });
});

describe("parsePreviewCopies", () => {
  it("keeps two refs and nothing else", () => {
    expect(parsePreviewCopies({ ...COPIES, extra: 1 })).toEqual(COPIES);
  });

  it("refuses anything else", () => {
    expect(parsePreviewCopies(null)).toBeNull();
    expect(parsePreviewCopies("x")).toBeNull();
    expect(parsePreviewCopies({ footage: COPIES.footage })).toBeNull();
    expect(parsePreviewCopies({ ...COPIES, cutout: { step: "x" } })).toBeNull();
  });
});

describe("previewKeys", () => {
  const args = (prefix: string) => ({
    r2Key: key(prefix),
    reelId: REEL,
    versionId: VERSION,
    inputs: INPUTS,
    previewCopies: COPIES,
  });

  it("gives the exact keys for the fixtures/pipeline fingerprints", () => {
    expect(previewKeys(args("dev/"))).toEqual({
      edit: key("dev/"),
      transcript: `dev/cache/retime/${fp("retime")}/transcript.json`,
      headTrack: `dev/cache/head_track/${fp("head_track")}/head-track.json`,
      footage: `dev/cache/preview_copies/${fp("preview_copies")}/footage-preview.mp4`,
      cutout: `dev/cache/preview_copies/${fp("preview_copies")}/subject-preview.webm`,
    });
  });

  it("works with an empty prefix", () => {
    expect(previewKeys(args(""))?.transcript).toBe(`cache/retime/${fp("retime")}/transcript.json`);
  });

  it("refuses a malformed fingerprint", () => {
    const bad = { ...COPIES, footage: { ...COPIES.footage, fingerprint: "ABC" } };
    expect(previewKeys({ ...args("dev/"), previewCopies: bad })).toBeNull();
    const short = { ...INPUTS, transcript: { ...INPUTS.transcript, fingerprint: "a".repeat(63) } };
    expect(previewKeys({ ...args("dev/"), inputs: short })).toBeNull();
  });

  it("refuses an unexpected step or a file that leaves its folder", () => {
    const step = { ...COPIES, cutout: { ...COPIES.cutout, step: "retime" } };
    expect(previewKeys({ ...args("dev/"), previewCopies: step })).toBeNull();
    const head = { ...INPUTS, head_track: { ...INPUTS.head_track, step: "retime" } };
    expect(previewKeys({ ...args("dev/"), inputs: head })).toBeNull();
    const file = { ...INPUTS, transcript: { ...INPUTS.transcript, file: "../x.json" } };
    expect(previewKeys({ ...args("dev/"), inputs: file })).toBeNull();
  });

  it("refuses a foreign version key and missing preview copies", () => {
    expect(previewKeys({ ...args("dev/"), r2Key: "dev/other.json" })).toBeNull();
    expect(previewKeys({ ...args("dev/"), previewCopies: null })).toBeNull();
  });
});
