import type * as HarfBuzzModule from "harfbuzzjs";
import { FONT_KEYS, type FontKey } from "./preset.ts";

// The initialised harfbuzzjs module, passed in by the caller: the worker
// imports it in Node, the studio in the browser. Both run the same wasm on
// the same font bytes, so every width is identical in both places.
export type HarfBuzz = Pick<typeof HarfBuzzModule, "Blob" | "Face" | "Font" | "Buffer" | "shape">;

export interface Measurer {
  // The advance width of the text set in the font at the size, in pixels.
  width(font: FontKey, sizePx: number, text: string): number;
  // Every text measured so far, `<font>:<text>` to its advance in font units,
  // sorted by key: what the golden files compare.
  widths(): Record<string, number>;
}

// HarfBuzz's own scale is the face's units per em, so the advances it
// returns are font units: width = sum(x_advance) * size / upem. Each text is
// shaped once per font; HarfBuzz objects are freed by harfbuzzjs's
// finalisers.
export function createMeasurer(hb: HarfBuzz, fonts: Record<FontKey, Uint8Array>): Measurer {
  const faces = Object.fromEntries(
    FONT_KEYS.map((key) => {
      const face = new hb.Face(new hb.Blob(fonts[key]));
      return [key, { font: new hb.Font(face), upem: face.upem }];
    }),
  ) as Record<FontKey, { font: HarfBuzzModule.Font; upem: number }>;
  const advances = new Map<string, number>();

  function advance(key: FontKey, text: string): number {
    const cacheKey = `${key}:${text}`;
    const known = advances.get(cacheKey);
    if (known !== undefined) return known;
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(faces[key].font, buffer);
    let total = 0;
    for (const position of buffer.getGlyphPositions()) total += position.xAdvance;
    advances.set(cacheKey, total);
    return total;
  }

  return {
    width(key, sizePx, text) {
      return (advance(key, text) * sizePx) / faces[key].upem;
    },
    widths() {
      return Object.fromEntries([...advances.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    },
  };
}
