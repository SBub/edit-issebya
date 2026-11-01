import { describe, expect, it } from "vitest";
import { PREVIEW_SETTINGS, previewSourceArgs, previewSubjectArgs } from "./preview-copies.ts";

const source = previewSourceArgs("in.mp4", "out.mp4", PREVIEW_SETTINGS);
const subject = previewSubjectArgs("in.webm", "out.webm", PREVIEW_SETTINGS);

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

describe("preview copies", () => {
  it("scale both to 540x960 at the source's own frame timing", () => {
    for (const args of [source, subject]) {
      expect(option(args, "-vf")).toBe("scale=540:960");
      expect(option(args, "-fps_mode")).toBe("passthrough");
      expect(args).not.toContain("-r");
      expect(args.some((arg) => arg.includes("fps="))).toBe(false);
      expect(option(args, "-g")).toBe("30");
      expect(option(args, "-keyint_min")).toBe("30");
    }
  });

  it("encode the footage as H.264 with AAC, audio optional", () => {
    expect(option(source, "-c:v")).toBe("libx264");
    expect(option(source, "-pix_fmt")).toBe("yuv420p");
    expect(option(source, "-c:a")).toBe("aac");
    expect(source).toContain("0:a:0?");
    expect(option(source, "-movflags")).toBe("+faststart");
    expect(source.at(-1)).toBe("out.mp4");
  });

  it("decode the cut-out with libvpx-vp9 and keep its alpha", () => {
    const input = subject.indexOf("-i");
    expect(subject.slice(0, input)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-c:v",
      "libvpx-vp9",
    ]);
    expect(option(subject.slice(input), "-c:v")).toBe("libvpx-vp9");
    expect(option(subject, "-pix_fmt")).toBe("yuva420p");
    expect(option(subject, "-auto-alt-ref")).toBe("0");
    expect(subject).toContain("-an");
    expect(subject.at(-1)).toBe("out.webm");
  });
});
