import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FootageRefused } from "../failure.ts";
import type { Tool } from "../step-runner.ts";
import {
  FOOTAGE_LIMITS,
  NOT_A_VIDEO,
  NO_SOUND,
  checkFootage,
  displaySize,
  footageRefusal,
  formatDuration,
} from "./footage-check.ts";
import { type Probe, parseProbe } from "./probe.ts";
import type { ToolPaths } from "./tools.ts";

function text(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  return readFileSync(new URL(`testdata/${name}.json`, import.meta.url), "utf8");
}

function fixture(name: string): Probe | null {
  try {
    return parseProbe(text(name));
  } catch {
    return null;
  }
}

const TOOLS: ToolPaths = {
  ffmpeg: "/fake/ffmpeg",
  ffprobe: "/fake/ffprobe",
  hyperframes: ["/fake/node", "/fake/hyperframes.mjs"],
};

describe("footageRefusal", () => {
  it("accepts the committed portrait clip's probe", () => {
    expect(footageRefusal(fixture("sdr-cfr"))).toBeNull();
  });

  it("refuses landscape footage with its size", () => {
    expect(footageRefusal(fixture("probe-landscape"))).toBe(
      "This clip is 320 x 180, not vertical. The studio takes vertical clips only.",
    );
  });

  it("accepts portrait footage stored landscape with a rotation", () => {
    expect(footageRefusal(fixture("probe-rotated-portrait"))).toBeNull();
    expect(footageRefusal(fixture("probe-rotate-tag"))).toBeNull();
  });

  it("refuses footage without sound", () => {
    expect(footageRefusal(fixture("probe-no-audio"))).toBe(NO_SOUND);
  });

  it("refuses footage longer than the limit, naming both lengths", () => {
    expect(FOOTAGE_LIMITS.maxSeconds).toBe(90);
    expect(footageRefusal(fixture("probe-long"))).toBe(
      "This clip is 1 minute 40 seconds; the studio takes up to 1 minute 30 seconds.",
    );
  });

  it("refuses an image and an audio file with cover art as not a video", () => {
    expect(footageRefusal(fixture("probe-image"))).toBe(NOT_A_VIDEO);
    expect(footageRefusal(fixture("probe-cover-art-audio"))).toBe(NOT_A_VIDEO);
    expect(footageRefusal(null)).toBe(NOT_A_VIDEO);
    const withDuration = JSON.parse(text("probe-image")) as { format: { duration: string } };
    withDuration.format.duration = "0.040000";
    expect(footageRefusal(parseProbe(JSON.stringify(withDuration)))).toBe(NOT_A_VIDEO);
  });

  it("applies the rules in order: a video, sound, vertical, length", () => {
    const base = fixture("probe-long")!;
    const landscapeLong: Probe = { ...base, video: { ...base.video, width: 1920, height: 1080 } };
    expect(footageRefusal(landscapeLong)).toMatch(/not vertical/);
    expect(footageRefusal({ ...landscapeLong, audio: null })).toBe(NO_SOUND);
    expect(footageRefusal({ ...landscapeLong, audio: null, formatName: "image2" })).toBe(
      NOT_A_VIDEO,
    );
  });

  it("accepts exactly 90 seconds, refuses 90.4 as 1 minute 31 seconds", () => {
    const base = fixture("sdr-cfr")!;
    expect(footageRefusal({ ...base, durationSeconds: 90 })).toBeNull();
    expect(footageRefusal({ ...base, durationSeconds: 90.4 })).toBe(
      "This clip is 1 minute 31 seconds; the studio takes up to 1 minute 30 seconds.",
    );
  });

  it("refuses square footage and 180-degree landscape", () => {
    const base = fixture("sdr-cfr")!;
    expect(footageRefusal({ ...base, video: { ...base.video, width: 500, height: 500 } })).toBe(
      "This clip is 500 x 500, not vertical. The studio takes vertical clips only.",
    );
    const upsideDown = fixture("probe-landscape")!;
    expect(
      footageRefusal({ ...upsideDown, video: { ...upsideDown.video, rotation: 180 } }),
    ).toMatch(/320 x 180, not vertical/);
  });
});

describe("displaySize", () => {
  it("swaps width and height for a quarter turn only", () => {
    expect(displaySize(fixture("probe-rotated-portrait")!)).toEqual({ width: 1080, height: 1920 });
    expect(displaySize(fixture("probe-landscape")!)).toEqual({ width: 320, height: 180 });
  });
});

describe("formatDuration", () => {
  it.each([
    [45, "45 seconds"],
    [1, "1 second"],
    [0.2, "1 second"],
    [60, "1 minute"],
    [61, "1 minute 1 second"],
    [90, "1 minute 30 seconds"],
    [130, "2 minutes 10 seconds"],
    [120, "2 minutes"],
  ])("%s seconds is %s", (seconds, words) => {
    expect(formatDuration(seconds)).toBe(words);
  });
});

describe("checkFootage", () => {
  const answering =
    (stdout: string): Tool =>
    async () =>
      stdout;

  it("probes the file with ffprobe and describes accepted footage", async () => {
    const seen: string[][] = [];
    const tool: Tool = async (call) => {
      seen.push([call.file, ...call.args]);
      return text("probe-rotated-portrait");
    };
    expect(await checkFootage({ tool, tools: TOOLS, path: "/job/inputs/source" })).toEqual({
      what: "footage checked, 0:24, 1080 x 1920",
    });
    expect(seen[0]?.[0]).toBe("/fake/ffprobe");
    expect(seen[0]?.at(-1)).toBe("/job/inputs/source");
  });

  it("throws FootageRefused with the human message", async () => {
    await expect(
      checkFootage({ tool: answering(text("probe-no-audio")), tools: TOOLS, path: "/x" }),
    ).rejects.toEqual(new FootageRefused(NO_SOUND));
  });

  it("refuses a file ffprobe cannot read, or whose output is not JSON, as not a video", async () => {
    const unreadable: Tool = () =>
      Promise.reject(
        Object.assign(new Error("check_footage exited with 1\nInvalid data found"), {
          exitCode: 1,
        }),
      );
    await expect(checkFootage({ tool: unreadable, tools: TOOLS, path: "/x" })).rejects.toEqual(
      new FootageRefused(NOT_A_VIDEO),
    );
    await expect(
      checkFootage({ tool: answering("not json"), tools: TOOLS, path: "/x" }),
    ).rejects.toEqual(new FootageRefused(NOT_A_VIDEO));
  });

  it("rethrows a missing ffprobe or a killed one: a step failure, not a verdict", async () => {
    const missing: Tool = () =>
      Promise.reject(Object.assign(new Error("exited with 127"), { exitCode: 127 }));
    await expect(checkFootage({ tool: missing, tools: TOOLS, path: "/x" })).rejects.toThrow(
      "exited with 127",
    );
    const killed: Tool = () =>
      Promise.reject(
        Object.assign(new Error("exited with signal SIGKILL"), {
          exitCode: null,
          exitSignal: "SIGKILL",
        }),
      );
    await expect(checkFootage({ tool: killed, tools: TOOLS, path: "/x" })).rejects.toThrow(
      "SIGKILL",
    );
  });
});
