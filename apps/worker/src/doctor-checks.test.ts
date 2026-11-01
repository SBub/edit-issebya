import { describe, expect, it } from "vitest";
import { fakeAiRunner } from "./ai.ts";
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
      "Codecs:",
      " DEV.L. vp8                  On2 VP8 (decoders: vp8 libvpx) (encoders: libvpx)",
      " DEV.L. vp9                  Google VP9 (decoders: vp9 libvpx-vp9) (encoders: libvpx-vp9)",
    ].join("\n"),
  hyperframes: async () => "0.8.222\n",
  ai: () => fakeAiRunner([{ ok: true }]),
};

describe("runDoctor", () => {
  it("names the filters a build lacks", async () => {
    const { lines } = await runDoctor({
      ...PASSING,
      ffmpegFilters: async () => " ... atempo  A->A  Adjust audio tempo.",
    });
    expect(lines[3]).toBe("FAIL ffmpeg filters: missing zscale, tonemap, astats, ametadata");
  });

  it("names the VP9 decoder or encoder a build lacks", async () => {
    const vp9 = async (line: string) =>
      (await runDoctor({ ...PASSING, ffmpegCodecs: async () => line })).lines[4];
    expect(await vp9(" D.V.L. vp9  Google VP9 (decoders: vp9 libvpx-vp9)")).toBe(
      "FAIL ffmpeg vp9: missing libvpx-vp9 encoder",
    );
    expect(await vp9(" DEV.L. vp9  Google VP9 (decoders: vp9) (encoders: libvpx-vp9)")).toBe(
      "FAIL ffmpeg vp9: missing libvpx-vp9 decoder",
    );
    expect(
      await vp9(" DEV.L. vp8  On2 VP8 (decoders: vp8 libvpx-vp9) (encoders: libvpx-vp9)"),
    ).toBe("FAIL ffmpeg vp9: missing libvpx-vp9 decoder, libvpx-vp9 encoder");
  });

  it("passes every line with working dependencies", async () => {
    expect(await runDoctor(PASSING)).toEqual({
      lines: [
        "ok   supabase reachable",
        "ok   r2 bucket reachable",
        "ok   ffmpeg version 7.1",
        "ok   ffmpeg filters zscale, tonemap, atempo, astats, ametadata",
        "ok   ffmpeg vp9 libvpx-vp9 decoder and encoder",
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
      [{ ffmpegCodecs: async () => "" }, 4],
      [{ hyperframes: async () => Promise.reject(new Error("ENOENT")) }, 5],
      [{ ai: () => fakeAiRunner([{ ok: false }]) }, 6],
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
