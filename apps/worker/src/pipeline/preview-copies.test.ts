import { describe, expect, it } from "vitest";
import { PREVIEW_SETTINGS, footagePreviewArgs, subjectPreviewArgs } from "./preview-copies.ts";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

describe("footagePreviewArgs", () => {
  it("encodes a 540x960 H.264 copy with the source's frame timing", () => {
    expect(footagePreviewArgs("/in/source.mp4", "/out/f.part.mp4", PREVIEW_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "/in/source.mp4",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      "scale=540:960",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-b:v",
      "1200k",
      "-maxrate",
      "1500k",
      "-bufsize",
      "3000k",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "/out/f.part.mp4",
    ]);
  });
});

describe("subjectPreviewArgs", () => {
  const args = subjectPreviewArgs("/in/subject.webm", "/out/s.part.webm", PREVIEW_SETTINGS);

  it("keeps the alpha: libvpx-vp9 decoder before -i, yuva420p, no alt-ref, alpha_mode", () => {
    expect(args.slice(4, 8)).toEqual(["-c:v", "libvpx-vp9", "-i", "/in/subject.webm"]);
    expect(option(args, "-pix_fmt")).toBe("yuva420p");
    expect(option(args, "-auto-alt-ref")).toBe("0");
    expect(option(args, "-metadata:s:v:0")).toBe("alpha_mode=1");
    expect(args.at(-1)).toBe("/out/s.part.webm");
  });

  it("is the same size as the footage copy, with the GOP from the settings", () => {
    expect(option(args, "-vf")).toBe(["scale=540:960", "format=yuva420p"].join(","));
    expect(option(args, "-g")).toBe(
      String(PREVIEW_SETTINGS.fps * PREVIEW_SETTINGS.keyframeSeconds),
    );
    expect(option(args, "-fps_mode")).toBe("passthrough");
    expect(args.lastIndexOf("-c:v")).toBeGreaterThan(args.indexOf("-i"));
    expect(args[args.lastIndexOf("-c:v") + 1]).toBe("libvpx-vp9");
  });
});
