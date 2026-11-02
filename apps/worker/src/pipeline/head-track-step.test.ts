import { describe, expect, it } from "vitest";
import { HEAD_TRACK_SETTINGS } from "./head-track.ts";
import { headTrack, headTrackDecodeArgs } from "./head-track-step.ts";

describe("headTrackDecodeArgs", () => {
  it("decodes with libvpx-vp9 (alpha kept) to raw RGBA at 4 fps and 270x480", () => {
    const args = headTrackDecodeArgs("/in/subject.webm", "/out/frames.rgba", HEAD_TRACK_SETTINGS);
    expect(args).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-c:v",
      "libvpx-vp9",
      "-i",
      "/in/subject.webm",
      "-an",
      "-vf",
      "fps=4,scale=270:480",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "/out/frames.rgba",
    ]);
    expect(args.indexOf("libvpx-vp9")).toBeLessThan(args.indexOf("-i"));
  });

  it("is the head_track step, reading the cut-out and keeping its JSON", () => {
    expect(headTrack.name).toBe("head_track");
    expect(headTrack.outputs).toEqual([{ file: "head-track.json", retention: "kept" }]);
    expect(
      headTrack.inputs({ etag: "e", bytes: 1 }, { remove_background: "fp" }).map((i) => i.ref),
    ).toEqual([{ step: "remove_background", fingerprint: "fp", file: "subject.webm" }]);
  });
});
