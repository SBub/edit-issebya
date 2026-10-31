import { describe, expect, it } from "vitest";
import { fakeAiRunner } from "./ai.ts";
import { type DoctorDeps, runDoctor } from "./doctor-checks.ts";

const PASSING: DoctorDeps = {
  supabase: async () => {},
  r2: async () => {},
  ffmpeg: async () => "version 7.1",
  ai: () => fakeAiRunner([{ ok: true }]),
};

describe("runDoctor", () => {
  it("passes every line with working dependencies", async () => {
    expect(await runDoctor(PASSING)).toEqual({
      lines: [
        "ok   supabase reachable",
        "ok   r2 bucket reachable",
        "ok   ffmpeg version 7.1",
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
      [{ ai: () => fakeAiRunner([{ ok: false }]) }, 3],
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
