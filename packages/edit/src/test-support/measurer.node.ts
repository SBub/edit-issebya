import { readFile } from "node:fs/promises";
import * as hb from "harfbuzzjs";
import { type Measurer, createMeasurer } from "../measure.ts";
import { FONT_KEYS, type FontKey, ISSEBYA_PRESET } from "../preset.ts";

let fonts: Promise<Record<FontKey, Uint8Array>> | undefined;

// The preset's fonts from packages/edit/assets, read once per process.
function loadFonts(): Promise<Record<FontKey, Uint8Array>> {
  fonts ??= Promise.all(
    FONT_KEYS.map(async (key) => {
      const url = new URL(`../../${ISSEBYA_PRESET.fonts[key].file}`, import.meta.url);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's own font assets
      return [key, new Uint8Array(await readFile(url))] as const;
    }),
  ).then((entries) => Object.fromEntries(entries) as Record<FontKey, Uint8Array>);
  return fonts;
}

// A fresh measurer (an empty width record) over the shared fonts.
export async function nodeMeasurer(): Promise<Measurer> {
  return createMeasurer(hb, await loadFonts());
}
