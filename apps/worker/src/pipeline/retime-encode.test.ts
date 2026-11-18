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

  it("trims every audio piece to its video length and fades the last one out", () => {
    // 30 frames at 1.05x: 45714 samples.
    expect(graph).toContain("apad,atrim=end_sample=45714,");
    expect(graph).toMatch(/afade=t=out:st=[\d.]+:d=0\.03\[a2\]/);
    expect(count(graph, ":d=0.03")).toBe(1);
  });

  it("fades the sound out before every join and in after it, 5 ms each", () => {
    expect(RETIME_PRESET.joinFadeSeconds).toBe(0.005);
    // 240 samples at 48 kHz. The first piece only fades out, the last only
    // fades in (and carries the end fade), the middle one does both.
    expect(graph).toContain("atrim=end_sample=45714,afade=t=out:ss=45474:ns=240[a0]");
    // One frame at 0.6x: 2667 samples.
    expect(graph).toContain(
      "atrim=end_sample=2667,afade=t=in:ss=0:ns=240,afade=t=out:ss=2427:ns=240[a1]",
    );
    expect(graph).toMatch(/atrim=end_sample=42182,afade=t=in:ss=0:ns=240,afade=t=out:st=/);
    expect(count(graph, "afade=t=in")).toBe(2);
    expect(count(graph, "afade=t=out")).toBe(3);
  });

  it("changes no length: the fades come after each piece's trim, the video has none", () => {
    const audio = [...graph.matchAll(/apad,atrim=end_sample=(\d+)[^;]*\[a\d\]/g)];
    expect(audio.map((match) => Number(match[1]))).toEqual([45714, 2667, 42182]);
    // Every piece's sound is its video's length (its frames at its speed),
    // to the sample, so the whole is as long as the pieces planned.
    const planned = PLAN.segments.map(
      ({ orig, speed }) => (Math.round((orig[1] - orig[0]) * 30) / 30 / speed) * 48000,
    );
    audio.forEach((match, index) => {
      expect(Math.abs(Number(match[1]) - planned[index]!)).toBeLessThanOrEqual(0.5);
    });
    const lines = graph.split(";\n");
    for (const line of lines.filter((part) => part.startsWith("[0:v]"))) {
      expect(line).not.toContain("fade");
    }
    // The graph without fades is the same graph: nothing else moved.
    const plain = retimeFilterGraph(PLAN, 48000, { ...RETIME_PRESET, joinFadeSeconds: 0 });
    expect(count(plain, "afade=")).toBe(1);
    expect(graph.replaceAll(/,afade=t=(in|out):ss=\d+:ns=\d+/g, "")).toBe(plain);
  });

  it("gives a piece shorter than two fades half its length for each", () => {
    const long = retimeFilterGraph(PLAN, 48000, { ...RETIME_PRESET, joinFadeSeconds: 0.05 });
    // The 2667-sample piece: 1333 in, 1333 out, never overlapping.
    expect(long).toContain(
      "atrim=end_sample=2667,afade=t=in:ss=0:ns=1333,afade=t=out:ss=1334:ns=1333[a1]",
    );
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

  it("fades out into the cut and in after it, and ends with the end fade", () => {
    // 15 frames at 1.05x: 22857 samples.
    expect(graph).toContain("atrim=end_sample=22857,afade=t=out:ss=22617:ns=240[a0]");
    expect(graph).toMatch(
      /atrim=end_sample=22857,afade=t=in:ss=0:ns=240,afade=t=out:st=[\d.]+:d=0\.03\[a1\]/,
    );
    expect(count(graph, "afade=")).toBe(3);
  });
});

describe("retimeFilterGraph on a plan with cut pauses", () => {
  // 3 s of silence before the first word, a 1.2 s pause and trailing
  // silence: every piece's audio starts and ends on its video's frame.
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
      { id: "w0001", text: "there", start: 3, end: 3.5 },
      { id: "w0002", text: "are", start: 3.5, end: 4 },
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
    // A fade out and a fade in at each join, and the end fade.
    expect(count(graph, "afade=t=in")).toBe(video.length - 1);
    expect(count(graph, "afade=t=out")).toBe(video.length);
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
