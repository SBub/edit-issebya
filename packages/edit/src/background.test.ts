import { describe, expect, it } from "vitest";
import { backgroundMapSchema, backgroundSampler } from "./background.ts";
import { byteLuminance, luminanceByte, relativeLuminance } from "./contrast.ts";
import { backgroundMapOf } from "./test-support/backgrounds.ts";

const FRAME = { width: 1080, height: 1920 };
const WHITE = relativeLuminance("#FFFFFF");
const BLACK = 0;
const light = byteLuminance(luminanceByte(relativeLuminance("#D8C3A5")));

// Dark everywhere but a light patch at x 300 to 420, y 600 to 660 (four
// cells wide, two high), and light everywhere after 4 s.
const map = backgroundMapOf(FRAME, 6, (x, y, t) =>
  t >= 4 || (x >= 300 && x < 420 && y >= 600 && y < 660) ? "#D8C3A5" : "#101010",
);
const dark = byteLuminance(luminanceByte(relativeLuminance("#101010")));

function counting() {
  let decodes = 0;
  const decode = (data: string) => {
    decodes += 1;
    return atob(data);
  };
  return { decode, decodes: () => decodes };
}

describe("backgroundSampler", () => {
  it("returns the same value twice and decodes no frame again", () => {
    const { decode, decodes } = counting();
    const sampler = backgroundSampler(map, FRAME, decode);
    const box = { left: 300, right: 420, top: 600, bottom: 660 };
    const first = sampler.behind(box, { start: 0, end: 2 }, WHITE);
    const after = decodes();
    expect(after).toBe(4);
    expect(sampler.behind(box, { start: 0, end: 2 }, WHITE)).toBe(first);
    expect(sampler.behind(box, { start: 0, end: 2 }, BLACK)).toBe(first);
    expect(decodes()).toBe(after);
    expect(first).toBe(light);
  });

  it("agrees across samplers over the same map", () => {
    const box = { left: 100, right: 700, top: 500, bottom: 800 };
    const span = { start: 0.2, end: 3.1 };
    expect(backgroundSampler(map, FRAME).behind(box, span, WHITE)).toBe(
      backgroundSampler(map, FRAME).behind(box, span, WHITE),
    );
  });

  it("reads towards the text: a small light patch hides neither side", () => {
    // 8 of the 120 cells are light: under the median, so a light text reads
    // the 80th percentile (still dark) and a dark text the 20th (dark).
    const box = { left: 240, right: 540, top: 540, bottom: 900 };
    const sampler = backgroundSampler(map, FRAME);
    expect(sampler.behind(box, { start: 0, end: 1 }, WHITE)).toBe(dark);
    expect(sampler.behind(box, { start: 0, end: 1 }, BLACK)).toBe(dark);
    // Half light: a light text reads the light half, a dark text the dark one.
    const patch = { left: 300, right: 420, top: 580, bottom: 680 };
    expect(sampler.behind(patch, { start: 0, end: 1 }, BLACK)).toBe(dark);
    expect(sampler.behind(patch, { start: 0, end: 1 }, WHITE)).toBe(light);
  });

  it("reads the frames inside the span, else the nearest one", () => {
    const sampler = backgroundSampler(map, FRAME);
    const box = { left: 600, right: 700, top: 1000, bottom: 1100 };
    expect(sampler.behind(box, { start: 3, end: 3.9 }, WHITE)).toBe(dark);
    expect(sampler.behind(box, { start: 4, end: 5 }, WHITE)).toBe(light);
    // Shorter than a step: the frame nearest its middle.
    expect(sampler.behind(box, { start: 4.05, end: 4.3 }, WHITE)).toBe(light);
    expect(sampler.behind(box, { start: 3.55, end: 3.7 }, WHITE)).toBe(dark);
    // Past the last frame: the last one.
    expect(sampler.behind(box, { start: 7, end: 7.2 }, WHITE)).toBe(light);
  });

  it("reads only the cells inside the frame", () => {
    const edge = backgroundMapOf(FRAME, 1, (x) => (x < 60 ? "#FFFFFF" : "#000000"));
    const sampler = backgroundSampler(edge, FRAME);
    const box = { left: -200, right: 60, top: 0, bottom: 30 };
    expect(sampler.behind(box, { start: 0, end: 1 }, BLACK)).toBe(1);
    expect(
      sampler.behind({ left: -90, right: -10, top: 0, bottom: 30 }, { start: 0, end: 1 }, 0.4),
    ).toBe(0.4);
  });
});

describe("backgroundMapSchema", () => {
  it("parses a made map and refuses a frame of the wrong byte count", () => {
    expect(backgroundMapSchema.safeParse(map).success).toBe(true);
    const short = { ...map, frames: [map.frames[0]!.slice(0, -4), ...map.frames.slice(1)] };
    const result = backgroundMapSchema.safeParse(short);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/frame 0 is not 2304 bytes/);
  });
});
