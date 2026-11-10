import * as hb from "harfbuzzjs";
import antonioBold from "../../assets/fonts/Antonio-Bold.ttf?url";
import archivoExpandedBlack from "../../assets/fonts/Archivo-ExpandedBlack.ttf?url";
import herrVonMuellerhoff from "../../assets/fonts/HerrVonMuellerhoff-Regular.ttf?url";
import hurricane from "../../assets/fonts/Hurricane-Regular.ttf?url";
import inter from "../../assets/fonts/Inter-SemiBold.ttf?url";
import interTight from "../../assets/fonts/InterTight-SemiBold.ttf?url";
import oswaldExtraLight from "../../assets/fonts/Oswald-ExtraLight.ttf?url";
import oswaldMedium from "../../assets/fonts/Oswald-Medium.ttf?url";
import pinyonScript from "../../assets/fonts/PinyonScript-Regular.ttf?url";
import playfairDisplayItalic from "../../assets/fonts/PlayfairDisplay-Italic.ttf?url";
import syne from "../../assets/fonts/Syne-SemiBold.ttf?url";
import unbounded from "../../assets/fonts/Unbounded-Regular.ttf?url";
import {
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIRS,
  FONT_ROLES,
  type FontPair,
  type FontRole,
} from "../font-pairs.ts";
import { type Measurer, createMeasurer } from "../measure.ts";

// Every font file, served by the test server: the same bytes as the Node run.
const URLS: Record<string, string> = {
  "assets/fonts/Antonio-Bold.ttf": antonioBold,
  "assets/fonts/Archivo-ExpandedBlack.ttf": archivoExpandedBlack,
  "assets/fonts/HerrVonMuellerhoff-Regular.ttf": herrVonMuellerhoff,
  "assets/fonts/Hurricane-Regular.ttf": hurricane,
  "assets/fonts/Inter-SemiBold.ttf": inter,
  "assets/fonts/InterTight-SemiBold.ttf": interTight,
  "assets/fonts/Oswald-ExtraLight.ttf": oswaldExtraLight,
  "assets/fonts/Oswald-Medium.ttf": oswaldMedium,
  "assets/fonts/PinyonScript-Regular.ttf": pinyonScript,
  "assets/fonts/PlayfairDisplay-Italic.ttf": playfairDisplayItalic,
  "assets/fonts/Syne-SemiBold.ttf": syne,
  "assets/fonts/Unbounded-Regular.ttf": unbounded,
};

const files = new Map<string, Promise<Uint8Array>>();

function loadFile(path: string): Promise<Uint8Array> {
  let bytes = files.get(path);
  if (!bytes) {
    const url = URLS[path];
    if (!url) throw new Error(`no test URL for ${path}`);
    bytes = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`font ${url}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    });
    files.set(path, bytes);
  }
  return bytes;
}

// A fresh measurer (an empty width record) over a pair's files; the classic
// pair when none is named.
export async function browserMeasurer(
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
