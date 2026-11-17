/* eslint-disable no-secrets/no-secrets -- ffmpeg filter and option strings: long and dense, never a secret */
import { reelFrames } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { withMasks } from "../cutout/spans.ts";
import {
  type CompositeInput,
  compositeArgs,
  compositeGraph,
  cutoutSpans,
  footageJpegArgs,
  maskListText,
  parseMediaFacts,
  assertSoundCovers,
  soundCutArgs,
  soundPackets,
  soundPacketsArgs,
} from "./composite.ts";
import type { MediaFacts } from "./render-route.ts";
import { fixtureEdit } from "./render-test-support.ts";

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  width: 1080,
  height: 1920,
  rate: "30/1",
  avgRate: "30/1",
  frames: 979,
  range: "pc",
  pixFmt: "yuvj420p",
  hasAudio: true,
  ...over,
});
const mask = (frames: number): MediaFacts =>
  facts({ frames, range: "tv", pixFmt: "yuv420p", hasAudio: false });

// A real reel the composite was measured on (32.641 s, 980 frames, 979 footage
// frames, six cut-out spans): the graph below is the one that scored inside
// the bound on every frame against the single call's export.
const SPANS = [
  { start: 10.567, end: 12.3, facts: mask(52) },
  { start: 13.467, end: 15.2, facts: mask(52) },
  { start: 16.033, end: 17.767, facts: mask(52) },
  { start: 19, end: 20.733, facts: mask(52) },
  { start: 23.9, end: 28.933, facts: mask(151) },
  { start: 30.067, end: 31.8, facts: mask(52) },
];
const REEL: CompositeInput = {
  mode: "match",
  duration: 32.641,
  frames: reelFrames(32.641),
  width: 1080,
  height: 1920,
  footage: "/r/footage.mkv",
  footageFacts: facts(),
  spans: SPANS,
  maskList: "/r/masks.txt",
  behindFrames: "/r/behind/frames",
  frontFrames: "/r/front/frames",
  sound: "/r/sound.m4a",
  output: "/r/export.mp4",
};
const IN_SPANS =
  "between(n,318,368)+between(n,405,455)+between(n,481,533)+between(n,570,621)+between(n,717,867)+between(n,903,953)";
const LAYER =
  "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuva420p,setsar=1";
const MASK_CHAIN =
  "[3:v]select='not(between(n,51,51)+between(n,103,103)+between(n,410,410))'," +
  "setpts='(N+between(N,0,50)*318+between(N,51,101)*354+between(N,102,153)*379+between(N,154,205)*416+between(N,206,356)*511+between(N,357,407)*546)/(30*TB)'," +
  "scale=in_range=tv:out_range=pc:flags=bicubic,format=gray,fps=30:start_time=0,tpad=stop_mode=clone:stop=980,trim=end_frame=980,setsar=1[M]";

describe("compositeGraph", () => {
  it("is the measured graph in match mode: the JPEG copy, the held frame dropped, six spans", () => {
    const { inputs, graph } = compositeGraph(REEL);
    expect(inputs).toEqual([
      ["-i", "/r/footage.mkv"],
      ["-framerate", "30", "-start_number", "1", "-i", "/r/behind/frames/frame_%06d.png"],
      ["-framerate", "30", "-start_number", "1", "-i", "/r/front/frames/frame_%06d.png"],
      ["-f", "concat", "-safe", "0", "-i", "/r/masks.txt"],
      ["-i", "/r/sound.m4a"],
    ]);
    expect(graph).toEqual([
      // 979 footage frames for 980 output frames, and frame 533 (the one the
      // third span never extracts) dropped: the frame before fills both.
      "[0:v]select='lt(n,979)*not(eq(n,533))',fps=30,scale=in_color_matrix=bt601:in_range=pc:flags=neighbor+accurate_rnd,format=gbrp,scale=out_color_matrix=bt709:out_range=tv:flags=neighbor,format=yuv420p,tpad=stop_mode=clone:stop=980,trim=end_frame=980,setsar=1,split=2[Fa][Fb]",
      `[1:v]${LAYER}[Bv]`,
      `[Fa][Bv]overlay=format=yuv420:eof_action=pass:enable='${IN_SPANS}'[G]`,
      MASK_CHAIN,
      "[Fb][M]alphamerge[FM]",
      `[G][FM]overlay=format=yuv420:eof_action=pass:enable='${IN_SPANS}'[C]`,
      `[2:v]${LAYER}[Fv]`,
      "[C][Fv]overlay=format=yuv420:eof_action=pass[D]",
      "[D]format=yuv420p[V]",
    ]);
  });

  it("takes the footage straight from the decoder in clean mode, the rest unchanged", () => {
    const match = compositeGraph(REEL);
    const clean = compositeGraph({ ...REEL, mode: "clean", footage: "/r/source.mp4" });
    expect(clean.inputs[0]).toEqual(["-i", "/r/source.mp4"]);
    expect(clean.inputs.slice(1)).toEqual(match.inputs.slice(1));
    expect(clean.graph[0]).toBe(
      "[0:v]select='lt(n,979)*not(eq(n,533))',fps=30,scale=in_range=pc:out_range=tv:flags=bicubic,format=yuv420p,tpad=stop_mode=clone:stop=980,trim=end_frame=980,setsar=1,split=2[Fa][Fb]",
    );
    expect(clean.graph.slice(1)).toEqual(match.graph.slice(1));
  });

  it("scales footage and masks that are not the frame's size, and skips a scale nothing needs", () => {
    const small = { width: 720, height: 1280 };
    const scaled = compositeGraph({
      ...REEL,
      footageFacts: facts(small),
      spans: SPANS.map((span) => ({ ...span, facts: { ...span.facts, ...small } })),
    });
    expect(scaled.graph[0]).toContain(
      "format=gbrp,scale=1080:1920:out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuv420p",
    );
    expect(scaled.graph[3]).toContain("scale=1080:1920:in_range=tv:out_range=pc:flags=bicubic");
    const clean = compositeGraph({ ...REEL, mode: "clean", footageFacts: facts(small) });
    expect(clean.graph[0]).toContain(
      "fps=30,scale=1080:1920:in_range=pc:out_range=tv:flags=bicubic,",
    );
    // Limited-range footage of the frame's size needs no scale at all.
    const plain = compositeGraph({ ...REEL, mode: "clean", footageFacts: facts({ range: "tv" }) });
    expect(plain.graph[0]).toContain("fps=30,format=yuv420p,tpad");
  });

  it("is footage and front layer alone for a reel with no cut-out", () => {
    const { inputs, graph } = compositeGraph({
      ...REEL,
      spans: [],
      maskList: undefined,
      behindFrames: undefined,
    });
    expect(inputs).toEqual([
      ["-i", "/r/footage.mkv"],
      ["-framerate", "30", "-start_number", "1", "-i", "/r/front/frames/frame_%06d.png"],
      ["-i", "/r/sound.m4a"],
    ]);
    expect(graph).toEqual([
      "[0:v]select='lt(n,979)',fps=30,scale=in_color_matrix=bt601:in_range=pc:flags=neighbor+accurate_rnd,format=gbrp,scale=out_color_matrix=bt709:out_range=tv:flags=neighbor,format=yuv420p,tpad=stop_mode=clone:stop=980,trim=end_frame=980,setsar=1[Fa]",
      `[1:v]${LAYER}[Fv]`,
      "[Fa][Fv]overlay=format=yuv420:eof_action=pass[D]",
      "[D]format=yuv420p[V]",
    ]);
  });

  it("keeps only the frames the footage clip extracts, and never more than the footage has", () => {
    // 2.68 s: 81 output frames, 80 extracted, the footage has 83.
    const short = compositeGraph({
      ...REEL,
      duration: 2.68,
      frames: reelFrames(2.68),
      footageFacts: facts({ frames: 83 }),
      spans: [],
      maskList: undefined,
      behindFrames: undefined,
    });
    expect(short.graph[0]).toContain("select='lt(n,80)',fps=30");
    expect(short.graph[0]).toContain("tpad=stop_mode=clone:stop=81,trim=end_frame=81");
  });

  it("holds a mask that is shorter than its span, and drops a mask's frames past its span", () => {
    const { graph } = compositeGraph({
      ...REEL,
      spans: [
        // On 51 frames (318 to 368), the mask has 40: nothing dropped, the last held.
        { start: 10.567, end: 12.3, facts: mask(40) },
        // On 51 frames (405 to 455), the mask has 60: frames 51 to 59 of it dropped.
        { start: 13.467, end: 15.2, facts: mask(60) },
      ],
    });
    expect(graph[3]).toContain(
      "select='not(between(n,91,99))',setpts='(N+between(N,0,39)*318+between(N,40,90)*365)/(30*TB)'",
    );
  });

  it("refuses cut-out spans without the behind layer or the masks", () => {
    expect(() => compositeGraph({ ...REEL, maskList: undefined })).toThrow(
      "render: cut-out spans need the behind layer and the masks",
    );
  });
});

describe("compositeArgs", () => {
  it("decodes every input once, blends, encodes with the single call's x264 settings and copies the sound", () => {
    const { inputs, graph } = compositeGraph(REEL);
    expect(compositeArgs(REEL)).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      "-stats_period",
      "2",
      ...inputs.flat(),
      "-filter_complex",
      graph.join(";"),
      "-map",
      "[V]",
      "-map",
      "4:a:0",
      "-frames:v",
      "980",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "15",
      "-pix_fmt",
      "yuv420p",
      "-bf",
      "0",
      "-threads",
      "8",
      "-x264-params",
      "aq-mode=3:aq-strength=0.8:deblock=1,1:colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      "-r",
      "30",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      "/r/export.mp4",
    ]);
  });

  it("maps the sound from the last input whatever the inputs are", () => {
    const args = compositeArgs({
      ...REEL,
      spans: [],
      maskList: undefined,
      behindFrames: undefined,
    });
    expect(args[args.lastIndexOf("-map") + 1]).toBe("2:a:0");
  });
});

describe("the sound cut", () => {
  it("keeps ceil(samples / 1024) + 1 packets of the reel's padded length", () => {
    // Measured: 980 frames is 1,568,000 samples, 1533 packets in the single
    // call's export.
    expect(soundPackets(980)).toBe(1533);
    expect(soundPackets(81)).toBe(Math.ceil((2.7 * 48000) / 1024) + 1);
    expect(soundPackets(30)).toBe(48);
  });

  it("copies the stream and shortens the last packet with HyperFrames' own expression", () => {
    const target = 980 / 30;
    expect(
      soundCutArgs({ input: "/r/sound/sound.mp4", output: "/r/sound.m4a", frames: 980 }),
    ).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-i",
      "/r/sound/sound.mp4",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-frames:a",
      "1533",
      "-bsf:a",
      `setts=duration='if(gte((PTS+DURATION)*TB,${target}),round(${target}/TB-PTS),DURATION)'`,
      "/r/sound.m4a",
    ]);
  });

  it("counts the packets of several reel lengths", () => {
    // 1683 frames is 56.1 s, 2,692,800 samples: 2630 packets and one more.
    expect(soundPackets(1683)).toBe(2631);
    expect(soundPackets(1013)).toBe(1584);
    expect(soundPackets(3045)).toBe(4759);
  });

  it("counts the cut sound's packets with ffprobe", () => {
    expect(soundPacketsArgs("/r/sound.m4a")).toEqual([
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-count_packets",
      "-show_entries",
      "stream=nb_read_packets",
      "-of",
      "csv=p=0",
      "/r/sound.m4a",
    ]);
  });

  it("accepts a cut sound that holds every packet of the reel", () => {
    for (const frames of [81, 289, 1013, 1683, 3045]) {
      expect(() => assertSoundCovers(`${soundPackets(frames)}\n`, frames)).not.toThrow();
    }
  });

  it("refuses a cut sound shorter than the video, naming both lengths", () => {
    // What the fractional page rate left of a 1683-frame reel: 103 packets.
    expect(() => assertSoundCovers("103\n", 1683)).toThrow(
      "render: the sound is shorter than the video: 103 packets (2.20 s), the reel needs 2631 packets (56.10 s)",
    );
    for (const frames of [1013, 1683, 3045]) {
      expect(() => assertSoundCovers(String(soundPackets(frames) - 1), frames)).toThrow(
        /shorter than the video/,
      );
    }
  });

  it("refuses an answer that is no packet count", () => {
    expect(() => assertSoundCovers("", 81)).toThrow(/no packet count \(""\)/);
    expect(() => assertSoundCovers("N/A", 81)).toThrow(/shorter than the video/);
  });

  it("never cuts by time", () => {
    const args = soundCutArgs({ input: "/i.mp4", output: "/o.m4a", frames: 81 });
    expect(args).not.toContain("-t");
    expect(args).not.toContain("-to");
  });
});

describe("footageJpegArgs", () => {
  it("is HyperFrames' own extraction: bt601 full-range JPEG at quality 2, no sound, with progress", () => {
    expect(footageJpegArgs({ footage: "/r/source.mp4", output: "/r/footage.mkv" })).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      "-stats_period",
      "2",
      "-i",
      "/r/source.mp4",
      "-an",
      "-vf",
      "setparams=color_primaries=bt709:color_trc=iec61966-2-1,scale=flags=neighbor+accurate_rnd,format=gbrp,scale=out_color_matrix=bt601:out_range=pc:flags=neighbor,format=yuv420p",
      "-c:v",
      "mjpeg",
      "-q:v",
      "2",
      "/r/footage.mkv",
    ]);
  });
});

describe("maskListText", () => {
  it("lists the masks in order for the concat demuxer, quotes escaped", () => {
    expect(maskListText(["/s/a.mp4", "/s/it's.mp4"])).toBe(
      "file '/s/a.mp4'\nfile '/s/it'\\''s.mp4'\n",
    );
    expect(maskListText([])).toBe("");
  });
});

describe("parseMediaFacts", () => {
  it("reads the first video stream and whether there is sound", () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: "audio" },
        {
          codec_type: "video",
          width: 1080,
          height: 1920,
          pix_fmt: "yuvj420p",
          color_range: "pc",
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          nb_frames: "979",
        },
      ],
    });
    expect(parseMediaFacts(json)).toEqual(facts());
  });

  it("takes an unknown range as limited, a missing frame count as not a number, a cover as no video", () => {
    const stream = { codec_type: "video", width: 720, height: 1280, pix_fmt: "yuv420p" };
    expect(parseMediaFacts(JSON.stringify({ streams: [stream] }))).toEqual({
      width: 720,
      height: 1280,
      rate: "0/0",
      avgRate: "0/0",
      frames: Number.NaN,
      range: "tv",
      pixFmt: "yuv420p",
      hasAudio: false,
    });
    const cover = { ...stream, disposition: { attached_pic: 1 } };
    expect(() => parseMediaFacts(JSON.stringify({ streams: [cover] }))).toThrow(
      "render: no video stream",
    );
  });
});

describe("cutoutSpans", () => {
  it("is empty for a reel with nothing behind the speaker", async () => {
    const { edit, transcript } = await fixtureEdit();
    expect(cutoutSpans(edit, transcript)).toEqual([]);
  });

  it("gives each of the builder's spans its mask's project path, and refuses a span with no mask", async () => {
    const { edit, transcript, headTrack } = await fixtureEdit();
    const behind = {
      ...edit,
      tracks: {
        ...edit.tracks,
        behind: [
          {
            id: "behind-word",
            kind: "word" as const,
            text: "WORK",
            position: { x: 100, y: 700 },
            size: 200,
            start: { word: "w0001" },
            end: { word: "w0010", edge: "end" as const },
          },
        ],
      },
    };
    const masked = withMasks(behind, transcript, headTrack);
    const [planned] = masked.inputs.masks!;
    expect(cutoutSpans(masked, transcript)).toEqual([
      { start: planned!.start, end: planned!.end, path: `masks/${planned!.fingerprint}.mp4` },
    ]);
    expect(() => cutoutSpans(behind, transcript)).toThrow(
      "render: behind item behind-word has no cut-out",
    );
  });
});
