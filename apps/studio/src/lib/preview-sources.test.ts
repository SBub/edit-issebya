import type { EditInputs } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import manifest from "../../../../fixtures/pipeline/manifest.json" with { type: "json" };
import {
  type PreviewCopies,
  cachePrefixOf,
  parsePreviewCopies,
  previewKeys,
  thumbnailKey,
} from "./preview-sources";

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
  head_track: { step: "head_track", fingerprint: fp("head_track"), file: "head-track.json" },
};

const PREVIEW_REF = (file: string) => ({
  step: "preview_copies",
  fingerprint: fp("preview_copies"),
  file,
});
const LAYOUT = { everySeconds: 2, columns: 32, width: 90, height: 160 };

// The column as the worker writes it since preview_copies version 3.
const RAW = {
  footage: PREVIEW_REF("footage-preview.mp4"),
  thumbnail: PREVIEW_REF("thumbnail.jpg"),
  frames: PREVIEW_REF("frames.jpg"),
  frames_layout: LAYOUT,
};
const COPIES: PreviewCopies = {
  footage: RAW.footage,
  thumbnail: RAW.thumbnail,
  frames: { ref: RAW.frames, ...LAYOUT },
};

// A version 2 reel's column: the footage copy only.
const FOOTAGE_ONLY = { footage: RAW.footage };
const FOOTAGE_ONLY_COPIES: PreviewCopies = { footage: RAW.footage, thumbnail: null, frames: null };

// An old reel's column, written while the pipeline still made a cut-out.
const OLD_COPIES = {
  ...FOOTAGE_ONLY,
  cutout: { step: "preview_copies", fingerprint: "a".repeat(64), file: "subject-preview.webm" },
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
  it("keeps the footage, thumbnail and frames refs with the layout, nothing else", () => {
    expect(parsePreviewCopies({ ...RAW, extra: 1 })).toEqual(COPIES);
  });

  it("reads a footage-only column with no thumbnail and no frames", () => {
    expect(parsePreviewCopies(FOOTAGE_ONLY)).toEqual(FOOTAGE_ONLY_COPIES);
  });

  it("reads an old reel's column naming a cut-out copy as the footage alone", () => {
    expect(parsePreviewCopies(OLD_COPIES)).toEqual(FOOTAGE_ONLY_COPIES);
    expect(parsePreviewCopies({ ...FOOTAGE_ONLY, cutout: { step: "x" } })).toEqual(
      FOOTAGE_ONLY_COPIES,
    );
  });

  it("drops a malformed thumbnail or frames part to null, never the whole column", () => {
    expect(parsePreviewCopies({ ...RAW, thumbnail: { step: "x" } })?.thumbnail).toBeNull();
    expect(parsePreviewCopies({ ...RAW, frames: "x" })?.frames).toBeNull();
    expect(parsePreviewCopies({ ...RAW, frames_layout: undefined })?.frames).toBeNull();
    expect(
      parsePreviewCopies({ ...RAW, frames_layout: { ...LAYOUT, columns: 0 } })?.frames,
    ).toBeNull();
    expect(
      parsePreviewCopies({ ...RAW, frames_layout: { ...LAYOUT, everySeconds: 1.5 } })?.frames,
    ).toBeNull();
    expect(parsePreviewCopies({ ...RAW, frames_layout: { ...LAYOUT, width: "90" } })?.frames).toBe(
      null,
    );
    expect(parsePreviewCopies({ ...RAW, thumbnail: null })?.frames).toEqual(COPIES.frames);
  });

  it("refuses anything else", () => {
    expect(parsePreviewCopies(null)).toBeNull();
    expect(parsePreviewCopies("x")).toBeNull();
    expect(parsePreviewCopies({ cutout: OLD_COPIES.cutout })).toBeNull();
    expect(parsePreviewCopies({ footage: { step: "x" } })).toBeNull();
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
      frames: `dev/cache/preview_copies/${fp("preview_copies")}/frames.jpg`,
      masks: [],
      photoIds: [],
    });
  });

  it("gives each cut-out mask's key at its page path, and the photo ids", () => {
    const PHOTO = "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c";
    const mask = {
      step: "cutout" as const,
      fingerprint: "c".repeat(64),
      file: "mask.mp4",
      start: 1,
      end: 4,
    };
    const inputs = { ...INPUTS, masks: [mask], photos: [PHOTO] };
    expect(previewKeys({ ...args("dev/"), inputs })).toMatchObject({
      masks: [
        { path: `masks/${"c".repeat(64)}.mp4`, key: `dev/cache/cutout/${"c".repeat(64)}/mask.mp4` },
      ],
      photoIds: [PHOTO],
    });
    const wrongStep = { ...inputs, masks: [{ ...mask, step: "retime" }] } as unknown;
    expect(previewKeys({ ...args("dev/"), inputs: wrongStep as EditInputs })).toBeNull();
    const badPhoto = { ...inputs, photos: ["../x"] };
    expect(previewKeys({ ...args("dev/"), inputs: badPhoto })).toBeNull();
  });

  it("gives no frames key without a sprite or with a malformed one", () => {
    expect(previewKeys({ ...args("dev/"), previewCopies: FOOTAGE_ONLY_COPIES })?.frames).toBe(null);
    const bad = { ...COPIES, frames: { ...COPIES.frames!, ref: PREVIEW_REF("../x.jpg") } };
    const keys = previewKeys({ ...args("dev/"), previewCopies: bad });
    expect(keys?.frames).toBeNull();
    expect(keys?.footage).toBe(
      `dev/cache/preview_copies/${fp("preview_copies")}/footage-preview.mp4`,
    );
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
    const step = { ...COPIES, footage: { ...COPIES.footage, step: "retime" } };
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

describe("thumbnailKey", () => {
  const args = (prefix: string) => ({
    r2Key: key(prefix),
    reelId: REEL,
    versionId: VERSION,
    previewCopies: COPIES,
  });

  it("gives the thumbnail's key beside the other preview copies", () => {
    expect(thumbnailKey(args("dev/"))).toBe(
      `dev/cache/preview_copies/${fp("preview_copies")}/thumbnail.jpg`,
    );
    expect(thumbnailKey(args(""))).toBe(
      `cache/preview_copies/${fp("preview_copies")}/thumbnail.jpg`,
    );
  });

  it("is null without a thumbnail, preview copies or a matching version key", () => {
    expect(thumbnailKey({ ...args("dev/"), previewCopies: FOOTAGE_ONLY_COPIES })).toBeNull();
    expect(thumbnailKey({ ...args("dev/"), previewCopies: null })).toBeNull();
    expect(thumbnailKey({ ...args("dev/"), r2Key: "dev/other.json" })).toBeNull();
    expect(thumbnailKey({ ...args("dev/"), versionId: REEL })).toBeNull();
  });

  it("refuses a malformed ref", () => {
    const step = { ...COPIES, thumbnail: { ...COPIES.thumbnail!, step: "retime" } };
    expect(thumbnailKey({ ...args("dev/"), previewCopies: step })).toBeNull();
    const file = { ...COPIES, thumbnail: PREVIEW_REF("../t.jpg") };
    expect(thumbnailKey({ ...args("dev/"), previewCopies: file })).toBeNull();
    const fingerprint = { ...COPIES, thumbnail: { ...COPIES.thumbnail!, fingerprint: "ABC" } };
    expect(thumbnailKey({ ...args("dev/"), previewCopies: fingerprint })).toBeNull();
  });
});
