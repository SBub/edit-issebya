import { describe, expect, it } from "vitest";
import { retimeEncodeArgs, retimeFilterGraph } from "./retime-encode.ts";
import { type RetimePlan, planRetime } from "./retime-plan.ts";
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

describe("retimeFilterGraph with cut pauses", () => {
  // A trimmed start (0 to 0.5 s) and a cut pause (1 to 1.5 s).
  const CUT: RetimePlan = {
    segments: [
      { orig: [0.5, 1], speed: 1.05, new: [0, 0.5 / 1.05] },
      { orig: [1.5, 2], speed: 1.05, new: [0.5 / 1.05, 1 / 1.05] },
    ],
    durationSeconds: 1 / 1.05,
  };
  const graph = retimeFilterGraph(CUT, 48000, RETIME_PRESET);

  it("cuts audio and video at the same frame on both sides of a cut", () => {
    expect(graph).toContain("[0:v]trim=start_frame=15:end_frame=30,");
    expect(graph).toContain("[0:a]atrim=start_sample=24000:end_sample=48000,");
    expect(graph).toContain("[0:v]trim=start_frame=45:end_frame=60,");
    expect(graph).toContain("[0:a]atrim=start_sample=72000:end_sample=96000,");
    expect(graph).toContain("concat=n=2:v=1:a=1[vc][a]");
  });

  it("still fades only the last piece", () => {
    expect(count(graph, "afade=")).toBe(1);
    expect(graph).toMatch(/afade=t=out:st=[\d.]+:d=0\.03\[a1\]/);
  });
});

describe("retimeFilterGraph on a plan cut by the audio", () => {
  // 3 s of leading silence (the transcript's first word pinned at 0 in it), a
  // 1.2 s pause and trailing silence: every piece's audio starts and ends on
  // its video's frame.
  const silent: [number, number][] = [
    [0, 3],
    [4, 5.2],
    [6.2, 7],
  ];
  const envelope = Array.from({ length: 700 }, (_, index) =>
    silent.some(([a, b]) => index / 100 >= a && index / 100 < b) ? -60 : -20,
  );
  const plan = planRetime({
    words: [
      { id: "w0001", text: "there", start: 0, end: 1 },
      { id: "w0002", text: "are", start: 3, end: 4 },
      { id: "w0003", text: "two", start: 5.2, end: 6.2 },
    ],
    envelope,
    durationSeconds: 7,
    settings: RETIME_PRESET,
  });
  const graph = retimeFilterGraph(plan, 48000, RETIME_PRESET);

  it("trims audio and video at the same frame for every piece", () => {
    const video = [...graph.matchAll(/\[0:v\]trim=start_frame=(\d+):end_frame=(\d+)/g)];
    const audio = [...graph.matchAll(/\[0:a\]atrim=start_sample=(\d+):end_sample=(\d+)/g)];
    expect(video.length).toBeGreaterThanOrEqual(2);
    expect(audio).toHaveLength(video.length);
    video.forEach((match, index) => {
      expect(Number(audio[index]![1])).toBe(Number(match[1]) * 1600);
      expect(Number(audio[index]![2])).toBe(Number(match[2]) * 1600);
    });
    // The leading silence is trimmed and the pause cut: the pieces skip frames.
    expect(Number(video[0]![1])).toBeGreaterThan(0);
    expect(video.some((match, index) => index > 0 && match[1] !== video[index - 1]![2])).toBe(true);
    expect(count(graph, "afade=")).toBe(1);
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
