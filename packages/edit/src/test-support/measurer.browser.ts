import * as hb from "harfbuzzjs";
import golosUrl from "../../assets/fonts/GolosText-Bold.ttf?url";
import ralewayUrl from "../../assets/fonts/Raleway-Light.ttf?url";
import { type Measurer, createMeasurer } from "../measure.ts";
import { FONT_KEYS, type FontKey, ISSEBYA_PRESET } from "../preset.ts";

// The same font files as the Node run, served by the test server.
const URLS: Record<string, string> = {
  "assets/fonts/GolosText-Bold.ttf": golosUrl,
  "assets/fonts/Raleway-Light.ttf": ralewayUrl,
};

let fonts: Promise<Record<FontKey, Uint8Array>> | undefined;

function loadFonts(): Promise<Record<FontKey, Uint8Array>> {
  fonts ??= Promise.all(
    FONT_KEYS.map(async (key) => {
      const file = ISSEBYA_PRESET.fonts[key].file;
      const url = URLS[file];
      if (!url) throw new Error(`no test URL for ${file}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`font ${url}: HTTP ${response.status}`);
      return [key, new Uint8Array(await response.arrayBuffer())] as const;
    }),
  ).then((entries) => Object.fromEntries(entries) as Record<FontKey, Uint8Array>);
  return fonts;
}

// A fresh measurer (an empty width record) over the shared fonts.
export async function browserMeasurer(): Promise<Measurer> {
  return createMeasurer(hb, await loadFonts());
}
