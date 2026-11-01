import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Probe, isHdr, isVariableFrameRate, parseProbe, probeArgs } from "./probe.ts";

function fixture(name: string): Probe {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  return parseProbe(readFileSync(new URL(`testdata/${name}.json`, import.meta.url), "utf8"));
}

describe("parseProbe", () => {
  it("reads the video, the audio and the duration", () => {
    expect(fixture("sdr-cfr")).toEqual({
      video: {
        codec: "h264",
        width: 320,
        height: 568,
        rFrameRate: "30/1",
        avgFrameRate: "30/1",
        colorTransfer: null,
        colorPrimaries: null,
        colorSpace: null,
      },
      audio: { codec: "aac", sampleRate: 48000 },
      durationSeconds: 2,
    });
    expect(fixture("vfr").audio).toBeNull();
  });

  it("refuses a file without video or duration", () => {
    expect(() => parseProbe('{"streams":[{"codec_type":"audio"}]}')).toThrow("no video");
    expect(() => parseProbe('{"streams":[{"codec_type":"video"}],"format":{}}')).toThrow(
      "no duration",
    );
  });

  it("asks ffprobe for JSON streams and format", () => {
    expect(probeArgs("/in.mov")).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      "/in.mov",
    ]);
  });
});

describe("isHdr", () => {
  it("is true for PQ and HLG, false for SDR", () => {
    expect(isHdr(fixture("hdr-pq"))).toBe(true);
    expect(isHdr(fixture("hdr-hlg"))).toBe(true);
    expect(isHdr(fixture("sdr-cfr"))).toBe(false);
    expect(isHdr(fixture("sdr-60fps-cfr"))).toBe(false);
  });
});

describe("isVariableFrameRate", () => {
  it("is true when the average differs from the base rate", () => {
    expect(isVariableFrameRate(fixture("vfr"))).toBe(true);
    expect(isVariableFrameRate(fixture("sdr-cfr"))).toBe(false);
    expect(isVariableFrameRate(fixture("sdr-60fps-cfr"))).toBe(false);
  });

  it("treats an unknown rate as variable and tolerates NTSC rounding", () => {
    const base = fixture("sdr-cfr");
    const withRates = (rFrameRate: string, avgFrameRate: string) => ({
      ...base,
      video: { ...base.video, rFrameRate, avgFrameRate },
    });
    expect(isVariableFrameRate(withRates("30/1", "0/0"))).toBe(true);
    expect(isVariableFrameRate(withRates("", "30/1"))).toBe(true);
    expect(isVariableFrameRate(withRates("30000/1001", "2997/100"))).toBe(false);
    expect(isVariableFrameRate(withRates("30/1", "1781/60"))).toBe(true);
  });
});
