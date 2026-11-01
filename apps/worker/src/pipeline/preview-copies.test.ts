import { describe, expect, it } from "vitest";
import { PREVIEW_SETTINGS, previewFootageArgs, previewSubjectArgs } from "./preview-copies.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

describe("previewFootageArgs", () => {
  it("makes a 540x960 H.264 copy keeping every frame and the audio", () => {
    expect(previewFootageArgs("source.mp4", "footage.part.mp4", PREVIEW_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "source.mp4",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      "scale=540:960:flags=lanczos",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-maxrate",
      "1400k",
      "-bufsize",
      "2800k",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      "footage.part.mp4",
    ]);
  });

  it("takes the size, the caps and the keyframe interval from the settings", () => {
    const args = previewFootageArgs("in.mp4", "out.mp4", {
      ...PREVIEW_SETTINGS,
      width: 360,
      height: 640,
      keyframeSeconds: 2,
      footage: { ...PREVIEW_SETTINGS.footage, maxrate: "900k", bufsize: "1800k" },
    });
    expect(option(args, "-vf")).toBe("scale=360:640:flags=lanczos");
    expect(option(args, "-maxrate")).toBe("900k");
    expect(option(args, "-bufsize")).toBe("1800k");
    expect(option(args, "-g")).toBe("60");
  });
});

describe("previewSubjectArgs", () => {
  it("makes a 540x960 VP9 copy with alpha Chrome plays", () => {
    const args = previewSubjectArgs("subject.webm", "subject.part.webm", PREVIEW_SETTINGS);
    expect(args).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-c:v",
      "libvpx-vp9",
      "-i",
      "subject.webm",
      "-vf",
      "scale=540:960:flags=lanczos",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "libvpx-vp9",
      "-crf",
      "34",
      "-b:v",
      "1000k",
      "-deadline",
      "good",
      "-cpu-used",
      "2",
      "-row-mt",
      "1",
      "-auto-alt-ref",
      "0",
      "-g",
      "30",
      "-pix_fmt",
      "yuva420p",
      "-metadata:s:v:0",
      "alpha_mode=1",
      "-an",
      "subject.part.webm",
    ]);
    // The alpha-keeping decoder is the one before the input.
    expect(args.indexOf("libvpx-vp9")).toBeLessThan(args.indexOf("-i"));
  });
});
