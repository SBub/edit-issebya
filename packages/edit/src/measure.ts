import type * as HarfBuzzModule from "harfbuzzjs";
import { FONT_ROLES, type FontPair, type FontRole } from "./font-pairs.ts";

// The initialised harfbuzzjs module, passed in by the caller: the worker
// imports it in Node, the studio in the browser. Both run the same wasm on
// the same font bytes, so every width is identical in both places.
export type HarfBuzz = Pick<typeof HarfBuzzModule, "Blob" | "Face" | "Font" | "Buffer" | "shape">;

export interface Measurer {
  // The pair whose files this measurer shapes. The builder reads it too, so
  // the page loads exactly the files the widths were measured in.
  readonly pair: FontPair;
  // The advance width of the text set in the font at the size, in pixels.
  width(font: FontRole, sizePx: number, text: string): number;
  // Every text measured so far, `<role>:<text>` to its advance in font units,
  // sorted by key: what the golden files compare.
  widths(): Record<string, number>;
}

// HarfBuzz's own scale is the face's units per em, so the advances it
// returns are font units: width = sum(x_advance) * size / upem. Each text is
// shaped once per font; HarfBuzz objects are freed by harfbuzzjs's
// finalisers. `fonts` holds the bytes of the pair's two files, by role.
export function createMeasurer(
  hb: HarfBuzz,
  pair: FontPair,
  fonts: Record<FontRole, Uint8Array>,
): Measurer {
  const faces = Object.fromEntries(
    FONT_ROLES.map((role) => {
      const face = new hb.Face(new hb.Blob(fonts[role]));
      return [role, { font: new hb.Font(face), upem: face.upem }];
    }),
  ) as Record<FontRole, { font: HarfBuzzModule.Font; upem: number }>;
  const advances = new Map<string, number>();

  function advance(role: FontRole, text: string): number {
    const cacheKey = `${role}:${text}`;
    const known = advances.get(cacheKey);
    if (known !== undefined) return known;
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(faces[role].font, buffer);
    let total = 0;
    for (const position of buffer.getGlyphPositions()) total += position.xAdvance;
    advances.set(cacheKey, total);
    return total;
  }

  return {
    pair,
    width(role, sizePx, text) {
      return (advance(role, text) * sizePx) / faces[role].upem;
    },
    widths() {
      return Object.fromEntries([...advances.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    },
  };
}
