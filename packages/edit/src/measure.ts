import * as hb from "harfbuzzjs";

// Text widths in pixels, from the font files themselves: HarfBuzz compiled to
// WebAssembly shapes the text the same way in Node and in Chromium, so the
// layout (and the page) is the same in both. The browser's own text metrics
// are never used.
export interface Measurer {
  width(fontKey: string, text: string, px: number): number;
  close(): void;
}

// `fonts` maps a preset font key to the font file's bytes; the caller reads
// them (fetch in the browser, readFile in Node).
export function createMeasurer(fonts: Record<string, Uint8Array>): Measurer {
  const loaded = new Map<string, { font: hb.Font; upem: number }>();
  for (const key of Object.keys(fonts).sort()) {
    const face = new hb.Face(new hb.Blob(fonts[key]!));
    loaded.set(key, { font: new hb.Font(face), upem: face.upem });
  }
  // Advances in font units (integers), keyed by font and text.
  const advances = new Map<string, number>();

  const unitsOf = (fontKey: string, text: string): { units: number; upem: number } => {
    const entry = loaded.get(fontKey);
    if (!entry) throw new Error(`no font bytes for "${fontKey}"`);
    const cacheKey = `${fontKey}|${text}`;
    let units = advances.get(cacheKey);
    if (units === undefined) {
      const buffer = new hb.Buffer();
      buffer.addText(text);
      buffer.guessSegmentProperties();
      hb.shape(entry.font, buffer);
      units = 0;
      for (const position of buffer.getGlyphPositions()) units += position.xAdvance;
      advances.set(cacheKey, units);
    }
    return { units, upem: entry.upem };
  };

  return {
    width(fontKey, text, px) {
      const { units, upem } = unitsOf(fontKey, text);
      return (units * px) / upem;
    },
    close() {
      advances.clear();
      loaded.clear();
    },
  };
}
