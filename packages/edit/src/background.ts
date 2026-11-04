import { z } from "zod";
import { byteLuminance, luminanceByte } from "./contrast.ts";
import type { Box } from "./head-track.ts";

// THE BACKGROUND MAP: what is behind the text. The worker samples the retimed
// footage (`backgrounds` step) at `everySeconds`, each frame scaled down to a
// `columns` by `rows` grid, and stores each cell's WCAG relative luminance as
// one byte (0 to 255). A frame is the base64 of its bytes, row by row.

// The grid the worker makes: 2 frames a second, 30 px cells at 1080x1920.
export const BACKGROUND_GRID = { everySeconds: 0.5, columns: 36, rows: 64 } as const;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const backgroundMapSchema = z
  .object({
    version: z.literal(1),
    everySeconds: z.number().positive(),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    frames: z.array(z.string().regex(BASE64)).min(1),
  })
  .superRefine((map, ctx) => {
    // The base64 length of exactly `columns * rows` bytes.
    const length = 4 * Math.ceil((map.columns * map.rows) / 3);
    map.frames.forEach((frame, index) => {
      if (frame.length !== length) {
        ctx.addIssue({
          code: "custom",
          path: ["frames", index],
          message: `frame ${index} is not ${map.columns * map.rows} bytes`,
        });
      }
    });
  });

export type BackgroundMap = z.infer<typeof backgroundMapSchema>;

// What the layout engine asks: the robust background luminance under a box
// over a span, as a text of the given luminance sees it.
export interface Backgrounds {
  behind(box: Box, span: { start: number; end: number }, textLuminance: number): number;
}

// A sampler over one map for a frame size. Reads every cell the box touches
// (clipped to the frame) in every sampled frame inside `[start, end)`, or the
// one nearest the span's middle when none is, and takes the 80th percentile
// towards the text's luminance (nearest rank on the stored bytes): for a text
// lighter than the median cell the light end is what hurts, so it is the 80th
// from the dark end; for a darker text the 20th. A box wholly outside the
// frame reads nothing and gets the text's own luminance. Each frame is decoded
// once, when first read; each box and span is sorted once.
export function backgroundSampler(
  map: BackgroundMap,
  frame: { width: number; height: number },
  decode: (data: string) => string = atob,
): Backgrounds {
  const decoded: (Uint8Array | undefined)[] = [];
  const cells = map.columns * map.rows;
  const frameAt = (index: number): Uint8Array => {
    let bytes = decoded[index];
    if (!bytes) {
      const text = decode(map.frames[index]!);
      bytes = new Uint8Array(cells);
      for (let at = 0; at < cells; at += 1) bytes[at] = text.charCodeAt(at);
      decoded[index] = bytes;
    }
    return bytes;
  };
  const cellWidth = frame.width / map.columns;
  const cellHeight = frame.height / map.rows;
  const last = map.frames.length - 1;
  const sorted = new Map<string, Uint8Array>();

  const valuesUnder = (box: Box, span: { start: number; end: number }): Uint8Array => {
    const key = [
      box.left,
      box.right,
      box.top,
      box.bottom,
      Math.round(span.start * 1000),
      Math.round(span.end * 1000),
    ].join(",");
    const hit = sorted.get(key);
    if (hit) return hit;
    const c0 = Math.max(0, Math.floor(box.left / cellWidth));
    const c1 = Math.min(map.columns - 1, Math.ceil(box.right / cellWidth) - 1);
    const r0 = Math.max(0, Math.floor(box.top / cellHeight));
    const r1 = Math.min(map.rows - 1, Math.ceil(box.bottom / cellHeight) - 1);
    const indices: number[] = [];
    for (let index = 0; index <= last; index += 1) {
      const t = index * map.everySeconds;
      if (t >= span.start - 1e-9 && t < span.end - 1e-9) indices.push(index);
    }
    if (indices.length === 0) {
      const middle = (span.start + span.end) / 2;
      indices.push(Math.min(last, Math.max(0, Math.round(middle / map.everySeconds))));
    }
    const out: number[] = [];
    if (c0 <= c1 && r0 <= r1) {
      for (const index of indices) {
        const bytes = frameAt(index);
        for (let row = r0; row <= r1; row += 1) {
          for (let col = c0; col <= c1; col += 1) out.push(bytes[row * map.columns + col]!);
        }
      }
    }
    const values = Uint8Array.from(out).sort();
    sorted.set(key, values);
    return values;
  };

  return {
    behind(box, span, textLuminance) {
      const values = valuesUnder(box, span);
      const n = values.length;
      if (n === 0) return textLuminance;
      const median = values[Math.floor((n - 1) / 2)]!;
      const text = luminanceByte(textLuminance);
      const rank = text > median ? Math.ceil((4 * n) / 5) : Math.ceil(n / 5);
      return byteLuminance(values[Math.max(0, rank - 1)]!);
    },
  };
}
