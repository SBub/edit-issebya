import { describe, expect, it } from "vitest";
import { fingerprint } from "../pipeline/fingerprint.ts";
import { MASK_TOOL_VERSION } from "./mask-tool.ts";
import { MATTE_SETTINGS } from "./matte.ts";
import { cutoutKey, maskFingerprint, plannedMasks, withMasks } from "./spans.ts";
import { BEHIND_PHOTO, BEHIND_TRANSCRIPT, behindEdit } from "./test-support.ts";

const FOOTAGE = { step: "retime", fingerprint: "a".repeat(64), file: "source.mp4" };

describe("maskFingerprint", () => {
  it("is the same for the same footage and span, and changes with either", () => {
    const span = { start: 5.1, end: 7.967 };
    const fp = maskFingerprint(FOOTAGE, span);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(maskFingerprint({ ...FOOTAGE }, { ...span })).toBe(fp);
    expect(maskFingerprint(FOOTAGE, { ...span, end: 8 })).not.toBe(fp);
    expect(maskFingerprint(FOOTAGE, { ...span, start: 5.133 })).not.toBe(fp);
    expect(maskFingerprint({ ...FOOTAGE, fingerprint: "b".repeat(64) }, span)).not.toBe(fp);
  });

  it("names the tool version and changes with every matte setting", () => {
    expect(MASK_TOOL_VERSION).toBe(2);
    const span = { start: 5.1, end: 7.967 };
    const fp = maskFingerprint(FOOTAGE, span);
    for (const [name, value] of Object.entries(MATTE_SETTINGS)) {
      const changed = { ...MATTE_SETTINGS, [name]: `${value}-other` };
      expect(
        fingerprint({ inputs: [FOOTAGE], settings: { ...span, ...changed }, version: 2 }),
      ).not.toBe(fp);
    }
    expect(
      fingerprint({ inputs: [FOOTAGE], settings: { ...span, ...MATTE_SETTINGS }, version: 2 }),
    ).toBe(fp);
    expect(
      fingerprint({ inputs: [FOOTAGE], settings: { ...span, ...MATTE_SETTINGS }, version: 1 }),
    ).not.toBe(fp);
  });
});

describe("cutoutKey", () => {
  it("is the cache layout of the cutout step's mask", () => {
    expect(cutoutKey("dev/", "f".repeat(64))).toBe(`dev/cache/cutout/${"f".repeat(64)}/mask.mp4`);
  });
});

describe("withMasks", () => {
  it("names one planned mask per padded span and the photos", () => {
    const edit = behindEdit();
    const named = withMasks(edit, BEHIND_TRANSCRIPT);
    expect(named.inputs.masks).toEqual(plannedMasks(edit, BEHIND_TRANSCRIPT));
    expect(named.inputs.masks?.map(({ start, end }) => [start, end])).toEqual([
      [5.1, 7.967],
      [19.967, 22.733],
    ]);
    expect(named.inputs.masks?.[0]).toMatchObject({ step: "cutout", file: "mask.mp4" });
    expect(named.inputs.masks?.[0]?.fingerprint).toBe(
      maskFingerprint(edit.inputs.footage, { start: 5.1, end: 7.967 }),
    );
    expect(named.inputs.photos).toEqual([BEHIND_PHOTO]);
  });

  it("names no mask for a photo in front of the speaker, only for what sits behind", () => {
    const edit = behindEdit();
    const photo = edit.tracks.behind!.find((item) => item.kind === "photo")!;
    if (photo.kind !== "photo") throw new Error("not a photo");
    photo.layer = "front";
    const named = withMasks(edit, BEHIND_TRANSCRIPT);
    // The big word keeps its span; the photo's is gone.
    expect(named.inputs.masks?.map(({ start, end }) => [start, end])).toEqual([[19.967, 22.733]]);
    expect(named.inputs.photos).toEqual([BEHIND_PHOTO]);
    edit.tracks.behind = [photo];
    const front = withMasks(edit, BEHIND_TRANSCRIPT);
    expect(front.inputs).not.toHaveProperty("masks");
    expect(front.inputs.photos).toEqual([BEHIND_PHOTO]);
  });

  it("drops masks and photos from an edit without behind items", () => {
    const edit = withMasks(behindEdit(), BEHIND_TRANSCRIPT);
    delete edit.tracks.behind;
    const named = withMasks(edit, BEHIND_TRANSCRIPT);
    expect(named.inputs).not.toHaveProperty("masks");
    expect(named.inputs).not.toHaveProperty("photos");
  });
});
