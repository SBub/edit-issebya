import { describe, expect, it } from "vitest";
import { HEAD_TRACK_SETTINGS } from "./head-track.ts";
import { U2NET_MODEL } from "./u2net-model.ts";
import {
  MASK_POOL,
  U2NET_SETTINGS,
  alphaToRgba,
  chunkBounds,
  maskEncodeArgs,
  maskPool,
  parseSampleCount,
  sampleCountArgs,
  u2netDecodeArgs,
  u2netInput,
  u2netMask,
} from "./u2net.ts";

const GB = 1024 ** 3;

describe("U2NET_SETTINGS", () => {
  it("names the pinned model by its SHA-256, the input size and the mask's encoding", () => {
    expect(U2NET_SETTINGS).toEqual({
      model: "u2net_int8_static13",
      modelSha256: U2NET_MODEL.sha256,
      size: 320,
      resize: "lanczos3",
      provider: "cpu",
      format: "vp9-alpha",
      crf: 18,
      cpuUsed: 4,
    });
    expect(U2NET_MODEL.file).toBe(`${U2NET_SETTINGS.model}.onnx`);
  });
});

describe("u2netInput", () => {
  it("divides by the frame's largest value, then takes the ImageNet mean and deviation, planar", () => {
    // Two pixels: (200, 100, 0) and (50, 200, 100); the largest value is 200.
    const input = new Float32Array(6);
    u2netInput(new Uint8Array([200, 100, 0, 50, 200, 100]), input);
    const expected = [
      (1 - 0.485) / 0.229,
      (0.25 - 0.485) / 0.229,
      (0.5 - 0.456) / 0.224,
      (1 - 0.456) / 0.224,
      (0 - 0.406) / 0.225,
      (0.5 - 0.406) / 0.225,
    ];
    for (const [index, value] of expected.entries()) expect(input[index]).toBeCloseTo(value, 6);
  });

  it("takes a black frame as it is (no division by zero)", () => {
    const input = new Float32Array(3);
    u2netInput(new Uint8Array(3), input);
    expect(input[0]).toBeCloseTo(-0.485 / 0.229, 6);
    expect(Number.isFinite(input[2])).toBe(true);
  });

  it("refuses an input of another size", () => {
    expect(() => u2netInput(new Uint8Array(6), new Float32Array(3))).toThrow(/6 bytes/);
  });
});

describe("u2netMask", () => {
  it("stretches the output from its smallest to its largest value over 0 to 255", () => {
    const mask = new Uint8Array(4);
    u2netMask(new Float32Array([0.2, 0.4, 0.3, 0.25]), mask);
    expect([...mask]).toEqual([0, 255, 128, 64]);
  });

  it("reads only the first output's plane and gives 0 for a flat output", () => {
    const mask = new Uint8Array(2);
    u2netMask(new Float32Array([0.5, 0.5, 9]), mask);
    expect([...mask]).toEqual([0, 0]);
  });
});

describe("alphaToRgba", () => {
  it("writes the mask as the alpha and leaves the colour", () => {
    const rgba = new Uint8Array(8);
    alphaToRgba(new Uint8Array([7, 200]), rgba);
    expect([...rgba]).toEqual([0, 0, 0, 7, 0, 0, 0, 200]);
    expect(() => alphaToRgba(new Uint8Array(3), rgba)).toThrow(/3 bytes/);
  });
});

describe("chunkBounds", () => {
  it("splits the samples into runs of the same length, the last one shorter", () => {
    expect(chunkBounds(218, 4)).toEqual([
      { first: 0, frames: 55 },
      { first: 55, frames: 55 },
      { first: 110, frames: 55 },
      { first: 165, frames: 53 },
    ]);
    expect(chunkBounds(10, 1)).toEqual([{ first: 0, frames: 10 }]);
  });

  it("gives fewer chunks than asked for when there are fewer samples", () => {
    expect(chunkBounds(2, 4)).toEqual([
      { first: 0, frames: 1 },
      { first: 1, frames: 1 },
    ]);
    expect(chunkBounds(0, 4)).toEqual([]);
  });

  it("covers every sample once, in order, whatever the split", () => {
    for (const frames of [1, 2, 3, 5, 7, 106, 131, 193, 218, 1000]) {
      for (const chunks of [1, 2, 3, 4, 8]) {
        const bounds = chunkBounds(frames, chunks);
        expect(bounds.length).toBeLessThanOrEqual(chunks);
        let next = 0;
        for (const chunk of bounds) {
          expect(chunk.first).toBe(next);
          expect(chunk.frames).toBeGreaterThan(0);
          next += chunk.frames;
        }
        expect(next).toBe(frames);
      }
    }
  });
});

describe("maskPool", () => {
  it("runs four chunks of two threads on eight CPUs", () => {
    const pool = maskPool(218, { cpus: 8, memoryBytes: 8 * GB });
    expect(pool.chunks).toHaveLength(4);
    expect(pool.threads).toBe(2);
  });

  it("never runs more chunks than CPUs, and gives every chunk the same threads", () => {
    expect(maskPool(100, { cpus: 2, memoryBytes: 8 * GB })).toMatchObject({ threads: 1 });
    expect(maskPool(100, { cpus: 2, memoryBytes: 8 * GB }).chunks).toHaveLength(2);
    expect(maskPool(100, { cpus: 1, memoryBytes: 8 * GB }).chunks).toHaveLength(1);
    expect(maskPool(100, { cpus: 16, memoryBytes: 64 * GB })).toMatchObject({ threads: 4 });
    expect(maskPool(100, { cpus: 16, memoryBytes: 64 * GB }).chunks).toHaveLength(4);
  });

  it("runs as many chunks as half the memory holds, at least one, on all the CPUs", () => {
    // Half of 2 GB holds two chunks of 512 MB.
    const two = maskPool(100, { cpus: 8, memoryBytes: 2 * GB });
    expect(two.chunks).toHaveLength(2);
    expect(two.threads).toBe(4);
    const one = maskPool(100, { cpus: 8, memoryBytes: 0.5 * GB });
    expect(one.chunks).toHaveLength(1);
    expect(one.threads).toBe(8);
    expect(MASK_POOL).toEqual({ chunks: 4, processBytes: 512 * 1024 ** 2, memoryShare: 0.5 });
  });

  it("gives the threads of the chunks there are, when the samples are few", () => {
    const pool = maskPool(2, { cpus: 8, memoryBytes: 8 * GB });
    expect(pool.chunks).toHaveLength(2);
    expect(pool.threads).toBe(4);
  });
});

describe("sampleCountArgs and parseSampleCount", () => {
  it("counts the sample clip's frames by decoding", () => {
    expect(sampleCountArgs("/s/samples.mp4")).toEqual([
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "default=nw=1:nk=1",
      "/s/samples.mp4",
    ]);
  });

  it("reads the count, and refuses none", () => {
    expect(parseSampleCount("218\n")).toBe(218);
    expect(() => parseSampleCount("0\n")).toThrow(/head_track: the sample clip has no frames/);
    expect(() => parseSampleCount("N/A\n")).toThrow(/no frames: N\/A/);
  });
});

describe("u2netDecodeArgs", () => {
  it("decodes the chunk's samples from its first one to raw RGB on stdout", () => {
    expect(
      u2netDecodeArgs({ input: "/s/samples.mp4", first: 55, frames: 54 }, HEAD_TRACK_SETTINGS),
    ).toEqual([
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-ss",
      "13.750000",
      "-i",
      "/s/samples.mp4",
      "-an",
      "-vf",
      "fps=4,scale=270:480",
      "-frames:v",
      "54",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-",
    ]);
  });
});

describe("maskEncodeArgs", () => {
  it("joins the chunks in order into one VP9 file with alpha, by HyperFrames' arguments", () => {
    expect(
      maskEncodeArgs(
        ["/s/mask-0.rgba", "/s/mask-1.rgba"],
        "/s/mask.part.webm",
        HEAD_TRACK_SETTINGS,
        U2NET_SETTINGS,
      ),
    ).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      "270x480",
      "-r",
      "4",
      "-i",
      "concat:/s/mask-0.rgba|/s/mask-1.rgba",
      "-vf",
      `scale=${["out_color_matrix=bt709", "out_range=tv", "flags=neighbor"].join(":")}`,
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "18",
      "-deadline",
      "good",
      "-row-mt",
      "1",
      "-cpu-used",
      "4",
      "-auto-alt-ref",
      "0",
      "-pix_fmt",
      "yuva420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      "-metadata:s:v:0",
      "alpha_mode=1",
      "-an",
      "/s/mask.part.webm",
    ]);
  });
});
