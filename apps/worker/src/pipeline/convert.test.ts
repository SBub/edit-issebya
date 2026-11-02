import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONVERT_SETTINGS, convertArgs, convertWhat } from "./convert.ts";
import { type Probe, parseProbe } from "./probe.ts";

function fixture(name: string): Probe {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  return parseProbe(readFileSync(new URL(`testdata/${name}.json`, import.meta.url), "utf8"));
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

describe("convertArgs", () => {
  it("re-encodes SDR to H.264 at a constant 30 fps, keyframes every second, AAC copied", () => {
    const args = convertArgs(fixture("sdr-cfr"), "/in", "/out.part.mp4", CONVERT_SETTINGS);
    expect(option(args, "-vf")).toBe("fps=30");
    expect(args.join(" ")).not.toContain("zscale");
    expect(option(args, "-c:v")).toBe("libx264");
    expect(option(args, "-fps_mode")).toBe("cfr");
    expect(option(args, "-r")).toBe("30");
    expect(option(args, "-g")).toBe("30");
    expect(option(args, "-keyint_min")).toBe("30");
    expect(option(args, "-sc_threshold")).toBe("0");
    expect(option(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*1)");
    expect(option(args, "-pix_fmt")).toBe("yuv420p");
    expect(option(args, "-c:a")).toBe("copy");
    expect(option(args, "-movflags")).toBe("+faststart");
    expect(args).not.toContain("-color_trc");
    expect(option(args, "-i")).toBe("/in");
    expect(args.at(-1)).toBe("/out.part.mp4");
  });

  it("tone-maps PQ and HLG to SDR BT.709 and tags the output", () => {
    for (const name of ["hdr-pq", "hdr-hlg"]) {
      const args = convertArgs(fixture(name), "/in", "/out.part.mp4", CONVERT_SETTINGS);
      expect(option(args, "-vf")?.split(",")).toEqual([
        "zscale=t=linear:npl=100",
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=hable:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
        "format=yuv420p",
        "fps=30",
      ]);
      expect(option(args, "-color_primaries")).toBe("bt709");
      expect(option(args, "-color_trc")).toBe("bt709");
      expect(option(args, "-colorspace")).toBe("bt709");
    }
  });

  it("encodes non-AAC audio to AAC and leaves out audio options without audio", () => {
    const opus = fixture("sdr-cfr");
    opus.audio = { codec: "opus", sampleRate: 48000 };
    const args = convertArgs(opus, "/in", "/out.part.mp4", CONVERT_SETTINGS);
    expect(option(args, "-c:a")).toBe("aac");
    expect(option(args, "-b:a")).toBe("256k");
    expect(convertArgs(fixture("vfr"), "/in", "/o.mp4", CONVERT_SETTINGS)).not.toContain("-c:a");
  });
});

describe("convertWhat", () => {
  it("names the fixes the footage needed", () => {
    expect(convertWhat(fixture("sdr-cfr"))).toBe("footage converted");
    expect(convertWhat(fixture("hdr-hlg"))).toBe("footage converted, HDR to SDR");
    expect(convertWhat(fixture("vfr"))).toBe("footage converted, variable frame rate fixed");
  });
});
