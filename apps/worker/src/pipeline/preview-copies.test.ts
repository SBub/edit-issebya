import { describe, expect, it } from "vitest";
import { PREVIEW_SETTINGS, previewFootageArgs, previewSubjectArgs } from "./preview-copies.ts";

const footage = previewFootageArgs(
  "/job/source.mp4",
  "/job/preview.part.mp4",
  PREVIEW_SETTINGS,
  30,
);
const subject = previewSubjectArgs(
  "/job/subject.webm",
  "/job/preview-subject.part.webm",
  PREVIEW_SETTINGS,
  30,
);

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

describe("preview copies", () => {
  it("scale both to the same width, keeping the aspect", () => {
    expect(option(footage, "-vf")).toBe("scale=540:-2");
    expect(option(subject, "-vf")).toBe("scale=540:-2");
  });

  it("never change the frame rate or timing", () => {
    for (const args of [footage, subject]) {
      expect(args).not.toContain("-r");
      expect(option(args, "-vf")).not.toMatch(/fps=/);
      expect(option(args, "-fps_mode")).toBe("passthrough");
      expect(option(args, "-g")).toBe("30");
    }
  });

  it("make the footage H.264 with audio and the moov atom first", () => {
    expect(option(footage, "-c:v")).toBe("libx264");
    expect(option(footage, "-pix_fmt")).toBe("yuv420p");
    expect(option(footage, "-c:a")).toBe("aac");
    expect(option(footage, "-movflags")).toBe("+faststart");
    expect(footage.at(-1)).toBe("/job/preview.part.mp4");
  });

  it("make the cut-out VP9 with alpha, decoded with libvpx-vp9, without audio", () => {
    expect(subject.slice(subject.indexOf("-c:v"), subject.indexOf("-i") + 2)).toEqual([
      "-c:v",
      "libvpx-vp9",
      "-i",
      "/job/subject.webm",
    ]);
    expect(subject.lastIndexOf("-c:v")).toBeGreaterThan(subject.indexOf("-i"));
    expect(subject[subject.lastIndexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(option(subject, "-pix_fmt")).toBe("yuva420p");
    expect(subject).toContain("-an");
    expect(subject.at(-1)).toBe("/job/preview-subject.part.webm");
  });
});
