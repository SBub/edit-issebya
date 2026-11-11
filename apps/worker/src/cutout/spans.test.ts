import { describe, expect, it } from "vitest";
import type { BehindItem } from "@edit-issebya/edit";
import { fingerprint } from "../pipeline/fingerprint.ts";
import { MASK_TOOL_VERSION } from "./mask-tool.ts";
import { MATTE_SETTINGS } from "./matte.ts";
import { cutoutKey, maskFingerprint, plannedMasks, withMasks } from "./spans.ts";
import { BEHIND_HEAD_TRACK, BEHIND_TRANSCRIPT, behindEdit } from "./test-support.ts";

const FOOTAGE = { step: "retime", fingerprint: "a".repeat(64), file: "source.mp4" };

describe("maskFingerprint", () => {
  it("is the same for the same footage and span, and changes with either", () => {
    const span = { start: 5.1, end: 7.967, cropTop: 266 };
    const fp = maskFingerprint(FOOTAGE, span);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(maskFingerprint({ ...FOOTAGE }, { ...span })).toBe(fp);
    expect(maskFingerprint(FOOTAGE, { ...span, end: 8 })).not.toBe(fp);
    expect(maskFingerprint(FOOTAGE, { ...span, start: 5.133 })).not.toBe(fp);
    // Another crop is another mask: the rows above it are background.
    expect(maskFingerprint(FOOTAGE, { ...span, cropTop: 0 })).not.toBe(fp);
    expect(maskFingerprint(FOOTAGE, { ...span, cropTop: 267 })).not.toBe(fp);
    expect(maskFingerprint({ ...FOOTAGE, fingerprint: "b".repeat(64) }, span)).not.toBe(fp);
  });

  it("names the int8 model, the 384 size and the crop rule", () => {
    expect(MATTE_SETTINGS).toEqual({
      model: "modnet_int8_13",
      modelSha256: "a293b5ae8fb8ac81447a82bf1ad661479fb412fe2d276188711386c6c81df28b",
      size: 384,
      crop: "above-head-half-width",
      smoothing: "median3",
      provider: "cpu",
      format: "h264-gray",
    });
    // What version 2 named for the same span: its masks are never taken for these.
    const old = {
      model: "modnet_photographic_portrait_matting",
      modelSha256: "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9",
      size: 512,
      smoothing: "median3",
      provider: "cpu",
      format: "h264-gray",
    };
    expect(
      fingerprint({ inputs: [FOOTAGE], settings: { start: 5.1, end: 7.967, ...old }, version: 2 }),
    ).not.toBe(maskFingerprint(FOOTAGE, { start: 5.1, end: 7.967, cropTop: 0 }));
  });

  it("names the tool version and changes with every matte setting", () => {
    expect(MASK_TOOL_VERSION).toBe(3);
    const span = { start: 5.1, end: 7.967, cropTop: 266 };
    const fp = maskFingerprint(FOOTAGE, span);
    for (const [name, value] of Object.entries(MATTE_SETTINGS)) {
      const changed = { ...MATTE_SETTINGS, [name]: `${value}-other` };
      expect(
        fingerprint({ inputs: [FOOTAGE], settings: { ...span, ...changed }, version: 3 }),
      ).not.toBe(fp);
    }
    expect(
      fingerprint({ inputs: [FOOTAGE], settings: { ...span, ...MATTE_SETTINGS }, version: 3 }),
    ).toBe(fp);
    expect(
      fingerprint({ inputs: [FOOTAGE], settings: { ...span, ...MATTE_SETTINGS }, version: 2 }),
    ).not.toBe(fp);
  });
});

describe("cutoutKey", () => {
  it("is the cache layout of the cutout step's mask", () => {
    expect(cutoutKey("dev/", "f".repeat(64))).toBe(`dev/cache/cutout/${"f".repeat(64)}/mask.mp4`);
  });
});

describe("withMasks", () => {
  it("names one planned mask per padded span", () => {
    const edit = behindEdit();
    const named = withMasks(edit, BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK);
    expect(named.inputs.masks).toEqual(plannedMasks(edit, BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK));
    expect(named.inputs.masks?.map(({ start, end }) => [start, end])).toEqual([
      [5.1, 7.967],
      [19.967, 22.733],
    ]);
    expect(named.inputs.masks?.[0]).toMatchObject({ step: "cutout", file: "mask.mp4" });
    expect(named.inputs.masks?.[0]?.fingerprint).toBe(
      maskFingerprint(edit.inputs.footage, { start: 5.1, end: 7.967, cropTop: 266 }),
    );
    // No head track: the same spans, uncropped, so other masks.
    expect(withMasks(edit, BEHIND_TRANSCRIPT, null).inputs.masks?.[0]?.fingerprint).toBe(
      maskFingerprint(edit.inputs.footage, { start: 5.1, end: 7.967, cropTop: 0 }),
    );
  });

  it("names no mask for a VISUAL, which sits over the footage: only a big word gets one", () => {
    const edit = behindEdit();
    const big = edit.tracks.behind!.at(-1)!;
    const visual: BehindItem = {
      id: "visual-1",
      kind: "visual",
      box: { x: 0, y: 0, width: 10, height: 10 },
      start: { time: 5.1 },
      end: { time: 7.967 },
    };
    edit.tracks.behind = [visual, big];
    const named = withMasks(edit, BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK);
    // The big word keeps its span; the VISUAL's is gone.
    expect(named.inputs.masks?.map(({ start, end }) => [start, end])).toEqual([[19.967, 22.733]]);
    edit.tracks.behind = [visual];
    const front = withMasks(edit, BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK);
    expect(front.inputs).not.toHaveProperty("masks");
  });

  it("drops masks from an edit without behind items", () => {
    const edit = withMasks(behindEdit(), BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK);
    delete edit.tracks.behind;
    const named = withMasks(edit, BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK);
    expect(named.inputs).not.toHaveProperty("masks");
  });
});
