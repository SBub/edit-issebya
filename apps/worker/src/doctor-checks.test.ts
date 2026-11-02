import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeStorage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AiRequest,
  type AiRunner,
  EMPTY_DECIDE_ANSWER,
  fakeAiRunner,
  resultEnvelope,
} from "./ai.ts";
import { type DoctorDeps, runDoctor } from "./doctor-checks.ts";

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

// Answers the image call (the one with `readFile`) with a description and
// every other call with the empty decide answer, noting each request and the
// files its folder held.
function answeringAi(): AiRunner & { calls: AiRequest[]; folders: string[][] } {
  const decide = fakeAiRunner([resultEnvelope(EMPTY_DECIDE_ANSWER)]);
  const image = fakeAiRunner([resultEnvelope(DESCRIBED)]);
  const calls: AiRequest[] = [];
  const folders: string[][] = [];
  return {
    calls,
    folders,
    async call(tool, request) {
      calls.push(request);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the check's temp folder
      folders.push(await readdir(request.cwd));
      return (request.readFile ? image : decide).call(tool, request);
    },
  };
}

const PASSING: DoctorDeps = {
  supabase: async () => {},
  r2: () => ({ storage, prefix: "dev/" }),
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
  ai: () => answeringAi(),
  scratchDir: async () => ({ dir: "/scratch", state: "exists" }),
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

  it("passes every line with working dependencies and leaves no probe behind", async () => {
    expect(await runDoctor(PASSING)).toEqual({
      lines: [
        "ok   supabase reachable",
        "ok   r2 bucket readable and writable",
        "ok   ffmpeg version 7.1",
        "ok   ffmpeg filters zscale, tonemap, atempo, astats, ametadata",
        "ok   ffmpeg codecs libx264, libvpx-vp9, libvpx-vp9 decoder",
        "ok   hyperframes 0.8.222",
        "ok   ai structured call",
        "ok   ai image call",
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
    expect(creatable.lines[8]).toBe("ok   scratch dir /scratch/prod can be created");
    expect(creatable.exitCode).toBe(0);
    const failing = await runDoctor({
      ...PASSING,
      scratchDir: async () => Promise.reject(new Error("/scratch is not a folder")),
    });
    expect(failing.lines[8]).toBe("FAIL scratch dir: /scratch is not a folder");
    expect(failing.exitCode).toBe(1);
  });

  it("sends the sample photo alone as photo.jpg, readable only by name, with the describe schema", async () => {
    const ai = answeringAi();
    await runDoctor({ ...PASSING, ai: () => ai });
    const image = ai.calls.findIndex((call) => call.readFile !== undefined);
    expect(ai.calls[image]).toMatchObject({ readFile: "photo.jpg" });
    expect(ai.folders[image]).toEqual(["photo.jpg"]);
    const schema = ai.calls[image]!.schema as { $schema?: unknown; properties?: object };
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(Object.keys(schema.properties ?? {})).toEqual(["description", "tags"]);
    // Every other call has no tools.
    expect(ai.calls.filter((call) => call.readFile !== undefined)).toHaveLength(1);
  });

  it("sends the real decide schema, the draft the Claude Code CLI validates", async () => {
    const ai = answeringAi();
    await runDoctor({ ...PASSING, ai: () => ai });
    expect(ai.calls).toHaveLength(2);
    const schema = ai.calls[0]!.schema as { $schema?: unknown; properties?: object };
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "tracks",
      "change_summary",
      "unexpressed",
      "free_field",
    ]);
    expect(JSON.stringify(schema)).toContain('"enum":["w0001","w0002"]');
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
      [{ ai: () => fakeAiRunner([resultEnvelope({ ok: false })]) }, [6, 7]],
      [{ ai: () => fakeAiRunner(["not json"]) }, [6, 7]],
      [{ ai: () => fakeAiRunner([resultEnvelope(EMPTY_DECIDE_ANSWER)]) }, 7],
      [{ scratchDir: async () => Promise.reject(new Error("/scratch is not writable")) }, 8],
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
