import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Probe, isHdr, isVariableFrameRate, parseProbe, probeArgs } from "./probe.ts";

function fixture(name: string): Probe {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  return parseProbe(readFileSync(new URL(`testdata/${name}.json`, import.meta.url), "utf8"));
}

function readJson(name: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  return JSON.parse(readFileSync(new URL(`testdata/${name}.json`, import.meta.url), "utf8"));
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
        rotation: 0,
      },
      audio: { codec: "aac", sampleRate: 48000 },
      durationSeconds: 2,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    });
    expect(fixture("vfr").audio).toBeNull();
  });

  it("refuses a file without video or duration", () => {
    expect(() => parseProbe('{"streams":[{"codec_type":"audio"}]}')).toThrow("no video");
    expect(() => parseProbe('{"streams":[{"codec_type":"video"}],"format":{}}')).toThrow(
      "no duration",
    );
  });

  it("reads the rotation from the Display Matrix, then the rotate tag", () => {
    expect(fixture("probe-rotated-portrait").video.rotation).toBe(270);
    expect(fixture("probe-rotate-tag").video.rotation).toBe(90);
    const both = {
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
          tags: { rotate: "180" },
          side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
        },
      ],
      format: { duration: "2" },
    };
    expect(parseProbe(JSON.stringify(both)).video.rotation).toBe(90);
  });

  it("skips an attached picture (cover art) as the video stream", () => {
    expect(() => parseProbe(JSON.stringify(readJson("probe-cover-art-audio")))).toThrow("no video");
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
