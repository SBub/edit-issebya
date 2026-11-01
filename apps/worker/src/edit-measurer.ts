import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  FONT_KEYS,
  type FontKey,
  ISSEBYA_PRESET,
  type Measurer,
  createMeasurer,
} from "@edit-issebya/edit";
import * as hb from "harfbuzzjs";

let measurer: Promise<Measurer> | undefined;

// The builder's HarfBuzz measurer over the preset's fonts, read from
// packages/edit's assets once per process (harfbuzzjs loads its own wasm on
// import). The studio measures the same bytes with the same wasm.
export function editMeasurer(): Promise<Measurer> {
  measurer ??= Promise.all(
    FONT_KEYS.map(async (key) => {
      const path = fileURLToPath(
        import.meta.resolve(`@edit-issebya/edit/${ISSEBYA_PRESET.fonts[key].file}`),
      );
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own font assets
      return [key, new Uint8Array(await readFile(path))] as const;
    }),
  ).then((entries) =>
    createMeasurer(hb, Object.fromEntries(entries) as Record<FontKey, Uint8Array>),
  );
  return measurer;
}
