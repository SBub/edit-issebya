import { describe, expect, it } from "vitest";
import { envelopeArgs, parseEnvelope, silentRuns } from "./envelope.ts";

const PRINT = `frame:0    pts:0       pts_time:0
lavfi.astats.Overall.RMS_level=-52.637215
frame:1    pts:480     pts_time:0.01
lavfi.astats.Overall.RMS_level=-inf
frame:2    pts:960     pts_time:0.02
lavfi.astats.Overall.RMS_level=-20.5
`;

describe("envelopeArgs", () => {
  it("measures the RMS level of every 10 ms into the print file", () => {
    const args = envelopeArgs("/job/converted.mp4", "envelope.txt");
    expect(args[args.indexOf("-af") + 1]).toBe(
      "aresample=48000,asetnsamples=n=480:p=0,astats=metadata=1:reset=1," +
        "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=envelope.txt",
    );
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("refuses a file name the filter graph would misread", () => {
    expect(() => envelopeArgs("/in", "a:b,c.txt")).toThrow("unsafe file name");
  });
});

describe("parseEnvelope", () => {
  it("reads every level, -inf as -180", () => {
    expect(parseEnvelope(PRINT)).toEqual([-52.637215, -180, -20.5]);
  });
});

describe("silentRuns", () => {
  it("finds runs below the threshold at the right times", () => {
    const db = [-20, -50, -50, -20, -20, -45, -60, -10, -41];
    const runs = silentRuns(db, -40, 0.01);
    expect(runs.map(([a, b]) => [a.toFixed(2), b.toFixed(2)])).toEqual([
      ["0.01", "0.03"],
      ["0.05", "0.07"],
      ["0.08", "0.09"],
    ]);
    expect(silentRuns([-20, -30], -40, 0.01)).toEqual([]);
  });
});
