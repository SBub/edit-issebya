import { describe, expect, it } from "vitest";
import { retimeEncodeArgs, retimeFilterGraph } from "./retime-encode.ts";
import type { RetimePlan } from "./retime-plan.ts";
import { RETIME_PRESET } from "./retime-preset.ts";

const PLAN: RetimePlan = {
  segments: [
    { orig: [0, 1], speed: 1.05, new: [0, 1 / 1.05] },
    { orig: [1, 1 + 1 / 30], speed: 0.6, new: [1 / 1.05, 1 / 1.05 + 1 / 18] },
    { orig: [1 + 1 / 30, 2], speed: 1.1, new: [1 / 1.05 + 1 / 18, 1.9] },
  ],
  durationSeconds: 1.9,
};

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("retimeFilterGraph", () => {
  const graph = retimeFilterGraph(PLAN, 48000, RETIME_PRESET);

  it("has one trim and one atrim per segment, by frame and by sample", () => {
    expect(count(graph, "[0:v]trim=")).toBe(3);
    expect(count(graph, "[0:a]atrim=")).toBe(3);
    expect(graph).toContain("[0:v]trim=start_frame=0:end_frame=30,setpts=(PTS-STARTPTS)/1.05[v0]");
    expect(graph).toContain("[0:a]atrim=start_sample=48000:end_sample=49600,");
    expect(graph).toContain("concat=n=3:v=1:a=1[vc][a]");
    expect(graph).toContain("[vc]fps=30[v]");
  });

  it("keeps pitch above 1x and uses a rate change only below it", () => {
    expect(count(graph, "asetrate=")).toBe(1);
    expect(graph).toContain("asetrate=28800,aresample=48000");
    expect(graph).toContain("atempo=1.05");
    expect(graph).toContain("atempo=1.1");
  });

  it("trims every audio piece to its video length and fades the last one", () => {
    // 30 frames at 1.05x: 45714 samples.
    expect(graph).toContain("apad,atrim=end_sample=45714[a0]");
    expect(count(graph, "afade=")).toBe(1);
    expect(graph).toMatch(/afade=t=out:st=[\d.]+:d=0\.03\[a2\]/);
  });
});

describe("retimeEncodeArgs", () => {
  it("reads the graph from a file and encodes as the reference did", () => {
    const args = retimeEncodeArgs("/in.mp4", "graph.txt", "/out.part.mp4", RETIME_PRESET);
    expect(args.join(" ")).toBe(
      "-hide_banner -v error -y -i /in.mp4 -/filter_complex graph.txt -map [v] -map [a] " +
        "-c:v libx264 -preset medium -crf 18 -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p " +
        "-c:a aac -b:a 256k -movflags +faststart /out.part.mp4",
    );
  });
});
