import { transcriptSchema } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { transcriptJson } from "./retime.ts";
import { VOICE_WINDOW_SECONDS, parseVoice, voiceArgs } from "./voice.ts";

const PRINT = `frame:0    pts:0       pts_time:0
lavfi.astats.Overall.Peak_level=-14.896111
lavfi.astats.Overall.RMS_level=-27.803291
frame:1    pts:4800    pts_time:0.1
lavfi.astats.Overall.Peak_level=-4.018328
lavfi.astats.Overall.RMS_level=-13.915148
frame:2    pts:9600    pts_time:0.2
lavfi.astats.Overall.Peak_level=-inf
lavfi.astats.Overall.RMS_level=-inf
`;

describe("voiceArgs", () => {
  it("measures the RMS level and the peak of every 0.1 s into the print file", () => {
    const args = voiceArgs("/job/source.mp4", "voice.txt");
    expect(VOICE_WINDOW_SECONDS).toBe(0.1);
    expect(args[args.indexOf("-i") + 1]).toBe("/job/source.mp4");
    expect(args).toContain("-vn");
    expect(args[args.indexOf("-af") + 1]).toBe(
      "aresample=48000,asetnsamples=n=4800:p=0," +
        "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level+Peak_level," +
        "ametadata=mode=print:file=voice.txt",
    );
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("refuses a file name the filter graph would misread", () => {
    expect(() => voiceArgs("/in", "a:b,c.txt")).toThrow("unsafe file name");
  });
});

describe("parseVoice", () => {
  it("reads a level and a peak for every window, to a tenth of a dB, silence as -120", () => {
    expect(parseVoice(PRINT)).toEqual({
      windowSeconds: 0.1,
      levels: [-27.8, -13.9, -120],
      // A peak goes to the tenth above it, never under the real one.
      peaks: [-14.8, -4, -120],
    });
  });

  it("refuses a print with no window, or with a level and no peak", () => {
    expect(() => parseVoice("")).toThrow("voice: 0 levels and 0 peaks read");
    expect(() => parseVoice("lavfi.astats.Overall.RMS_level=-20\n")).toThrow(
      "voice: 1 levels and 0 peaks read",
    );
    expect(() => parseVoice("lavfi.astats.Overall.RMS_level=nan\n")).toThrow("unreadable level");
  });
});

describe("the retimed transcript as stored", () => {
  const words = [{ id: "w0001", text: "Hi.", start: 0.1, end: 0.4 }];

  it("holds the voice after the words, its two lists a line each, and reads back the same", () => {
    const voice = parseVoice(PRINT);
    const json = transcriptJson({ words, voice });
    expect(json).toBe(
      `${JSON.stringify({ words }, null, 2).slice(0, -2)},\n` +
        '  "voice": {\n' +
        '    "windowSeconds": 0.1,\n' +
        '    "levels": [-27.8,-13.9,-120],\n' +
        '    "peaks": [-14.8,-4,-120]\n' +
        "  }\n}\n",
    );
    expect(transcriptSchema.parse(JSON.parse(json))).toEqual({ words, voice });
  });

  it("is the words alone for a transcript with no measure, as before", () => {
    expect(transcriptJson({ words })).toBe(`${JSON.stringify({ words }, null, 2)}\n`);
    expect(transcriptSchema.parse({ words })).toEqual({ words });
  });

  it("is refused with a level list and a peak list of different lengths", () => {
    const voice = { windowSeconds: 0.1, levels: [-20, -21], peaks: [-6] };
    expect(transcriptSchema.safeParse({ words, voice }).success).toBe(false);
  });
});
