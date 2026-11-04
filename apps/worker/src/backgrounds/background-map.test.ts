import { backgroundMapSchema, backgroundSampler } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { BACKGROUND_SETTINGS, backgroundArgs, mapFromRaw } from "./background-map.ts";

const CELLS = 36 * 64;

// One RGB frame painted per cell (index 0 top left, row by row).
function frame(paint: (cell: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(CELLS * 3);
  for (let cell = 0; cell < CELLS; cell += 1) out.set(paint(cell), cell * 3);
  return out;
}

const bytesOf = (base64: string) => [...Buffer.from(base64, "base64")];

describe("mapFromRaw", () => {
  it("turns a white and a black frame into 255 and 0 per cell", () => {
    const raw = Buffer.concat([frame(() => [255, 255, 255]), frame(() => [0, 0, 0])]);
    const map = mapFromRaw(new Uint8Array(raw), BACKGROUND_SETTINGS);
    expect(map).toMatchObject({ version: 1, everySeconds: 0.5, columns: 36, rows: 64 });
    expect(map.frames).toHaveLength(2);
    expect(new Set(bytesOf(map.frames[0]!))).toEqual(new Set([255]));
    expect(new Set(bytesOf(map.frames[1]!))).toEqual(new Set([0]));
    expect(backgroundMapSchema.safeParse(map).success).toBe(true);
  });

  it("keeps each cell where it is: a frame light on the left half", () => {
    const raw = frame((cell) => (cell % 36 < 18 ? [216, 195, 165] : [16, 16, 16]));
    const map = mapFromRaw(raw, BACKGROUND_SETTINGS);
    const bytes = bytesOf(map.frames[0]!);
    expect(bytes[0]).toBe(144);
    expect(bytes[35]).toBe(1);
    const sampler = backgroundSampler(map, { width: 1080, height: 1920 });
    const left = sampler.behind(
      { left: 0, right: 500, top: 0, bottom: 100 },
      { start: 0, end: 1 },
      1,
    );
    const right = sampler.behind(
      { left: 580, right: 1080, top: 0, bottom: 100 },
      { start: 0, end: 1 },
      1,
    );
    expect(left).toBeGreaterThan(0.5);
    expect(right).toBeLessThan(0.01);
  });

  it("refuses a trailing partial frame and an empty output", () => {
    const raw = Buffer.concat([frame(() => [0, 0, 0]), Buffer.alloc(5)]);
    expect(() => mapFromRaw(new Uint8Array(raw), BACKGROUND_SETTINGS)).toThrow(/whole number/);
    expect(() => mapFromRaw(new Uint8Array(0), BACKGROUND_SETTINGS)).toThrow(/whole number/);
  });
});

describe("backgroundArgs", () => {
  it("samples 2 frames a second down to the grid as raw RGB", () => {
    expect(backgroundArgs("in.mp4", "out.rgb", BACKGROUND_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "in.mp4",
      "-map",
      "0:v:0",
      "-vf",
      "fps=2,scale=36:64:flags=area,format=rgb24",
      "-f",
      "rawvideo",
      "out.rgb",
    ]);
  });
});
