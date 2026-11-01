import { describe, expect, it } from "vitest";
import { exportKey, renderArgs } from "./render-args.ts";

describe("renderArgs", () => {
  it("is exactly the delivery render in software with three workers", () => {
    expect(renderArgs({ cli: "/hf.mjs", project: "/p", output: "/o.mp4" })).toEqual([
      "/hf.mjs",
      "render",
      "/p",
      "-o",
      "/o.mp4",
      "--quality",
      "delivery",
      "--workers",
      "3",
      "--no-browser-gpu",
      "--sdr",
      "--no-best-effort",
      "--quiet",
    ]);
  });

  it("never asks for a GPU", () => {
    const args = renderArgs({ cli: "/hf.mjs", project: "/p", output: "/o.mp4" });
    expect(args).not.toContain("--gpu");
    expect(args).not.toContain("--browser-gpu");
    expect(args).not.toContain("--hdr");
  });

  it("adds a range only when one is given", () => {
    const args = renderArgs({
      cli: "/hf.mjs",
      project: "/p",
      output: "/o.mp4",
      range: { start: 0, end: 3 },
    });
    expect(args.slice(-4)).toEqual(["--start", "0", "--end", "3"]);
    expect(renderArgs({ cli: "/hf.mjs", project: "/p", output: "/o.mp4" })).not.toContain(
      "--start",
    );
  });
});

describe("exportKey", () => {
  it("puts the export under the prefix, the reel and its own id", () => {
    expect(exportKey("dev/", "r1", "e1")).toBe("dev/exports/r1/e1.mp4");
    expect(exportKey("", "r1", "e1")).toBe("exports/r1/e1.mp4");
  });

  it("refuses a malformed prefix", () => {
    expect(() => exportKey("Dev/", "r1", "e1")).toThrow(/invalid storage key/);
    expect(() => exportKey("/abs/", "r1", "e1")).toThrow(/invalid storage key/);
  });
});
