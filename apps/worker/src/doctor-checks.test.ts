import { describe, expect, it } from "vitest";
import { fakeAiRunner, resultEnvelope } from "./ai.ts";
import { type DoctorDeps, runDoctor } from "./doctor-checks.ts";

const PASSING: DoctorDeps = {
  supabase: async () => {},
  r2: async () => {},
  ffmpeg: async () => "version 7.1",
  ffmpegFilters: async () =>
    [
      "Filters:",
      " ... atempo            A->A       Adjust audio tempo.",
      " ... astats            A->A       Show time domain statistics about audio frames.",
      " ... ametadata         A->A       Manipulate audio frame metadata.",
      " ... tonemap           V->V       Conversion to/from different dynamic ranges.",
      " ... zscale            V->V       Apply resizing, colorspace and bit depth conversion.",
    ].join("\n"),
  ffmpegCodecs: async () =>
    [
      "Encoders:",
      " V..... = Video",
      " ------",
      " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)",
      " V....D libvpx-vp9           libvpx VP9 (codec vp9)",
      "",
      "Decoders:",
      " ------",
      " VFS..D vp9                  Google VP9",
      " V..... libvpx-vp9           libvpx VP9 (codec vp9)",
    ].join("\n"),
  hyperframes: async () => "0.8.222\n",
  ai: () => fakeAiRunner([resultEnvelope({ ok: true })]),
};

describe("runDoctor", () => {
  it("names the filters a build lacks", async () => {
    const { lines } = await runDoctor({
      ...PASSING,
      ffmpegFilters: async () => " ... atempo  A->A  Adjust audio tempo.",
    });
    expect(lines[3]).toBe("FAIL ffmpeg filters: missing zscale, tonemap, astats, ametadata");
  });

  it("names the codecs a build lacks, encoders and decoders apart", async () => {
    const { lines } = await runDoctor({
      ...PASSING,
      ffmpegCodecs: async () =>
        [
          "Encoders:",
          " V....D libvpx-vp9           libvpx VP9 (codec vp9)",
          "Decoders:",
          " VFS..D vp9                  Google VP9",
        ].join("\n"),
    });
    expect(lines[4]).toBe("FAIL ffmpeg codecs: missing encoder libx264, decoder libvpx-vp9");
  });

  it("passes every line with working dependencies", async () => {
    expect(await runDoctor(PASSING)).toEqual({
      lines: [
        "ok   supabase reachable",
        "ok   r2 bucket reachable",
        "ok   ffmpeg version 7.1",
        "ok   ffmpeg filters zscale, tonemap, atempo, astats, ametadata",
        "ok   ffmpeg codecs libx264, libvpx-vp9, libvpx-vp9 decoder",
        "ok   hyperframes 0.8.222",
        "ok   ai structured call",
      ],
      exitCode: 0,
    });
  });

  it("fails only the line of the failing dependency", async () => {
    const cases: [Partial<DoctorDeps>, number][] = [
      [{ supabase: async () => Promise.reject(new Error("refused")) }, 0],
      [
        {
          r2: () => {
            throw new Error("missing R2_BUCKET");
          },
        },
        1,
      ],
      [{ ffmpeg: async () => Promise.reject(new Error("ENOENT")) }, 2],
      [{ ffmpegFilters: async () => " ... atempo  A->A  Adjust audio tempo." }, 3],
      [{ ffmpegCodecs: async () => "Encoders:\nDecoders:\n" }, 4],
      [{ hyperframes: async () => Promise.reject(new Error("ENOENT")) }, 5],
      [{ ai: () => fakeAiRunner([resultEnvelope({ ok: false })]) }, 6],
      [{ ai: () => fakeAiRunner(["not json"]) }, 6],
    ];
    for (const [override, failing] of cases) {
      const { lines, exitCode } = await runDoctor({ ...PASSING, ...override });
      expect(exitCode).toBe(1);
      lines.forEach((line, index) => {
        expect(line.startsWith("FAIL"), line).toBe(index === failing);
      });
    }
  });
});
