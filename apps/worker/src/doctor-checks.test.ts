import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeStorage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AiRequest,
  type AiRunner,
  EMPTY_DECIDE_ANSWER,
  fakeAiRunner,
  scriptedAnswer,
} from "./ai.ts";
import { type DoctorDeps, type MaskToolDeps, ffmpegMajor, runDoctor } from "./doctor-checks.ts";

let root: string;
let storage: FakeStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctor-r2-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const DESCRIBED = {
  description: "A colourful test pattern.",
  tags: ["test pattern", "colour bars", "abstract"],
};

// Answers the image call (the one with an image) with a description and
// every other call with the empty decide answer, noting each request.
function answeringAi(described: object = DESCRIBED): AiRunner & { calls: AiRequest[] } {
  const decide = fakeAiRunner([scriptedAnswer(EMPTY_DECIDE_ANSWER)]);
  const image = fakeAiRunner([scriptedAnswer(described)]);
  const calls: AiRequest[] = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      return (request.image ? image : decide).call(request);
    },
  };
}

const PASSING: DoctorDeps = {
  supabase: async () => {},
  r2: () => ({ storage, prefix: "dev/" }),
  ffmpeg: async () => "version 7.1",
  ffprobe: async () => "version 7.1",
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
  openRouterKey: () => "sk-or-test",
  ai: () => answeringAi(),
  maskTool: () => maskTool(),
  scratchDir: async () => ({ dir: "/scratch", state: "exists" }),
};

// A mask tool that builds, runs at once and gives a mask of the sample's size.
function maskTool(change: Partial<MaskToolDeps> = {}): MaskToolDeps {
  return {
    platform: "darwin",
    sample: "/fixtures/short-speech.mp4",
    build: async () => {},
    run: async () => {},
    probe: async (file) =>
      file === "/fixtures/short-speech.mp4"
        ? { codec: "h264", width: 720, height: 1280, frames: 83 }
        : { codec: "h264", width: 720, height: 1280, frames: 30 },
    ...change,
  };
}

describe("runDoctor's mask tool line", () => {
  const line = async (deps: MaskToolDeps) =>
    (await runDoctor({ ...PASSING, maskTool: () => deps })).lines[9];

  it("refuses off macOS with one line", async () => {
    expect(await line(maskTool({ platform: "linux" }))).toBe(
      "FAIL mask tool: the mask tool runs on macOS only (Apple Vision); this worker runs on linux",
    );
  });

  it("fails when the build fails", async () => {
    const build = async () => Promise.reject(new Error("swiftc: error: no such file"));
    expect(await line(maskTool({ build }))).toBe("FAIL mask tool: swiftc: error: no such file");
  });

  it("fails a mask of the wrong size or length", async () => {
    const wrong = maskTool({
      probe: async (file) =>
        file.endsWith("mask.mp4")
          ? { codec: "h264", width: 540, height: 960, frames: 30 }
          : { codec: "h264", width: 720, height: 1280, frames: 83 },
    });
    expect(await line(wrong)).toBe("FAIL mask tool: mask is 540x960, the footage 720x1280");
    const short = maskTool({
      probe: async (file) =>
        file.endsWith("mask.mp4")
          ? { codec: "h264", width: 720, height: 1280, frames: 12 }
          : { codec: "h264", width: 720, height: 1280, frames: 83 },
    });
    expect(await line(short)).toBe("FAIL mask tool: mask has 12 frames, not 30");
  });
});

describe("runDoctor", () => {
  it("fails the ffmpeg line on ffmpeg or ffprobe older than 7", async () => {
    const old = await runDoctor({
      ...PASSING,
      ffmpeg: async () => "version 6.1.1-3ubuntu5 Copyright",
    });
    expect(old.lines[2]).toBe(
      "FAIL ffmpeg: ffmpeg 6.1 found, 7 or newer is needed for HEIC photos (-show_stream_groups)",
    );
    expect(old.exitCode).toBe(1);
    const probe = await runDoctor({ ...PASSING, ffprobe: async () => "version n6.0 Copyright" });
    expect(probe.lines[2]).toBe(
      "FAIL ffmpeg: ffprobe 6.0 found, 7 or newer is needed for HEIC photos (-show_stream_groups)",
    );
  });

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

  it("passes every line with working dependencies and leaves no probe behind", async () => {
    expect(await runDoctor(PASSING)).toEqual({
      lines: [
        "ok   supabase reachable",
        "ok   r2 bucket readable and writable",
        "ok   ffmpeg version 7.1",
        "ok   ffmpeg filters zscale, tonemap, atempo, astats, ametadata",
        "ok   ffmpeg codecs libx264, libvpx-vp9, libvpx-vp9 decoder",
        "ok   hyperframes 0.8.222",
        "ok   openrouter key set",
        "ok   ai structured call anthropic/claude-haiku-5.5",
        "ok   ai image call",
        "ok   mask tool vseg built, 1 s masked in 0.0 s",
        "ok   scratch dir /scratch exists",
      ],
      exitCode: 0,
    });
    expect(await storage.list("dev/")).toEqual([]);
  });

  it("fails the r2 line naming the put when the key may only read", async () => {
    const { lines, exitCode } = await runDoctor({
      ...PASSING,
      r2: () => ({
        storage: { ...storage, put: async () => Promise.reject(new Error("Access Denied")) },
        prefix: "dev/",
      }),
    });
    expect(lines[1]).toMatch(
      /^FAIL r2 bucket readable and writable: put dev\/doctor\/probe-[0-9a-f]{12}\.txt: Access Denied$/,
    );
    expect(exitCode).toBe(1);
  });

  it("fails the r2 line naming the get when the probe reads back missing, and still deletes it", async () => {
    const { lines } = await runDoctor({
      ...PASSING,
      r2: () => ({ storage: { ...storage, get: async () => null }, prefix: "dev/" }),
    });
    expect(lines[1]).toMatch(
      /^FAIL r2 bucket readable and writable: get dev\/doctor\/probe-[0-9a-f]{12}\.txt: probe missing$/,
    );
    expect(await storage.list("dev/")).toEqual([]);
  });

  it("fails the r2 line naming the get when the probe reads back different bytes", async () => {
    const { lines } = await runDoctor({
      ...PASSING,
      r2: () => ({
        storage: { ...storage, get: async () => new TextEncoder().encode("other") },
        prefix: "dev/",
      }),
    });
    expect(lines[1]).toMatch(
      /^FAIL r2 bucket readable and writable: get dev\/doctor\/probe-[0-9a-f]{12}\.txt: probe differs$/,
    );
  });

  it("fails the r2 line naming the delete when the probe cannot be removed", async () => {
    const { lines } = await runDoctor({
      ...PASSING,
      r2: () => ({
        storage: { ...storage, delete: async () => Promise.reject(new Error("Access Denied")) },
        prefix: "dev/",
      }),
    });
    expect(lines[1]).toMatch(
      /^FAIL r2 bucket readable and writable: delete dev\/doctor\/probe-[0-9a-f]{12}\.txt: Access Denied$/,
    );
  });

  it("prints the scratch line for a folder that can be created and for a failure", async () => {
    const creatable = await runDoctor({
      ...PASSING,
      scratchDir: async () => ({ dir: "/scratch/prod", state: "can be created" }),
    });
    expect(creatable.lines[10]).toBe("ok   scratch dir /scratch/prod can be created");
    expect(creatable.exitCode).toBe(0);
    const failing = await runDoctor({
      ...PASSING,
      scratchDir: async () => Promise.reject(new Error("/scratch is not a folder")),
    });
    expect(failing.lines[10]).toBe("FAIL scratch dir: /scratch is not a folder");
    expect(failing.exitCode).toBe(1);
  });

  it("sends the sample photo as the one JPEG image, with the describe schema", async () => {
    const ai = answeringAi();
    await runDoctor({ ...PASSING, ai: () => ai });
    const images = ai.calls.filter((call) => call.image !== undefined);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ role: "describe", image: { mediaType: "image/jpeg" } });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed sample photo
    const sample = await readFile(new URL("../../../fixtures/photos/sample.jpg", import.meta.url));
    expect(Buffer.from(images[0]!.image!.data).equals(sample)).toBe(true);
    const schema = images[0]!.schema as { properties?: object };
    expect(Object.keys(schema.properties ?? {})).toEqual(["description", "tags"]);
  });

  it("makes one structured call with the real decide schema", async () => {
    const ai = answeringAi();
    await runDoctor({ ...PASSING, ai: () => ai });
    expect(ai.calls.map((call) => call.role)).toEqual(["decide", "describe"]);
    const schema = ai.calls[0]!.schema as { properties?: object };
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "accents",
      "big_words",
      "photos",
      "transitions",
      "word_fixes",
      "hook",
      "checklist",
      "behind_rules",
      "unexpressed",
    ]);
    expect(JSON.stringify(schema)).toContain('"enum":["w0001","w0002"]');
  });

  it("fails the key line on a missing or blank key, never printing a key", async () => {
    for (const key of [undefined, "", "  "]) {
      const { lines } = await runDoctor({ ...PASSING, openRouterKey: () => key });
      expect(lines[6]).toBe(
        "FAIL openrouter key: OPENROUTER_API_KEY is not set (apps/worker/.env.development)",
      );
    }
    const { lines } = await runDoctor(PASSING);
    expect(lines.join("\n")).not.toContain("sk-or-test");
  });

  it("fails only the line of the failing dependency", async () => {
    const cases: [Partial<DoctorDeps>, number | number[]][] = [
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
      [{ openRouterKey: () => undefined }, 6],
      [{ ai: () => fakeAiRunner([scriptedAnswer({ ok: false })]) }, [7, 8]],
      [{ ai: () => fakeAiRunner(["not json"]) }, [7, 8]],
      [{ ai: () => fakeAiRunner([{ error: { status: 401 } }]) }, [7, 8]],
      [{ ai: () => fakeAiRunner([scriptedAnswer(EMPTY_DECIDE_ANSWER)]) }, 8],
      [{ maskTool: () => maskTool({ platform: "linux" }) }, 9],
      [{ scratchDir: async () => Promise.reject(new Error("/scratch is not writable")) }, 10],
    ];
    for (const [override, failing] of cases) {
      const { lines, exitCode } = await runDoctor({ ...PASSING, ...override });
      expect(exitCode).toBe(1);
      const failingLines = Array.isArray(failing) ? failing : [failing];
      lines.forEach((line, index) => {
        expect(line.startsWith("FAIL"), line).toBe(failingLines.includes(index));
      });
    }
  });
});

describe("ffmpegMajor", () => {
  it("reads the major version of release, distro, static and git builds", () => {
    expect(ffmpegMajor("version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers")).toBe(8);
    expect(ffmpegMajor("version 6.1.1-3ubuntu5 Copyright")).toBe(6);
    expect(ffmpegMajor("version n7.0.2 Copyright")).toBe(7);
    expect(ffmpegMajor("version 7.0.2-static https://johnvansickle.com/ffmpeg/")).toBe(7);
    expect(ffmpegMajor("version N-117000-g1234abcd Copyright")).toBeNull();
  });
});
