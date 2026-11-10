import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIRS,
  FONT_ROLES,
  type FontPairId,
  type FontRole,
  type Measurer,
  createMeasurer,
} from "@edit-issebya/edit";
import * as hb from "harfbuzzjs";

const measurers = new Map<FontPairId, Promise<Measurer>>();

// The builder's HarfBuzz measurer over one font pair's files, read from
// packages/edit's assets once per process per pair (harfbuzzjs loads its own
// wasm on import). The studio measures the same bytes with the same wasm. The
// classic pair when none is named.
export function editMeasurer(id: FontPairId = DEFAULT_FONT_PAIR_ID): Promise<Measurer> {
  let measurer = measurers.get(id);
  if (!measurer) {
    const pair = FONT_PAIRS[id];
    measurer = Promise.all(
      FONT_ROLES.map(async (role: FontRole) => {
        const path = fileURLToPath(import.meta.resolve(`@edit-issebya/edit/${pair[role].file}`));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own font assets
        return [role, new Uint8Array(await readFile(path))] as const;
      }),
    ).then((files) =>
      createMeasurer(hb, pair, Object.fromEntries(files) as Record<FontRole, Uint8Array>),
    );
    measurers.set(id, measurer);
  }
  return measurer;
}
