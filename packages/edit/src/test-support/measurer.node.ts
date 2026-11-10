import { readFile } from "node:fs/promises";
import * as hb from "harfbuzzjs";
import {
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIRS,
  FONT_ROLES,
  type FontPair,
  type FontRole,
} from "../font-pairs.ts";
import { type Measurer, createMeasurer } from "../measure.ts";

const files = new Map<string, Promise<Uint8Array>>();

// A font file of packages/edit/assets, read once per process.
function loadFile(path: string): Promise<Uint8Array> {
  let bytes = files.get(path);
  if (!bytes) {
    const url = new URL(`../../${path}`, import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's own font assets
    bytes = readFile(url).then((data) => new Uint8Array(data));
    files.set(path, bytes);
  }
  return bytes;
}

// A fresh measurer (an empty width record) over a pair's files; the classic
// pair when none is named.
export async function nodeMeasurer(
  pair: FontPair = FONT_PAIRS[DEFAULT_FONT_PAIR_ID],
): Promise<Measurer> {
  const bytes = await Promise.all(FONT_ROLES.map((role) => loadFile(pair[role].file)));
  return createMeasurer(
    hb,
    pair,
    Object.fromEntries(FONT_ROLES.map((role, index) => [role, bytes[index]!])) as Record<
      FontRole,
      Uint8Array
    >,
  );
}
