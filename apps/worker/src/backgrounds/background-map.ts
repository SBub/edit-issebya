import {
  BACKGROUND_GRID,
  type BackgroundMap,
  luminanceByte,
  rgbLuminance,
} from "@edit-issebya/edit";

// The background map's settings (packages/edit's grid): 2 frames a second,
// each scaled down to 36 by 64 cells. Part of the step's fingerprint.
export const BACKGROUND_SETTINGS = {
  everySeconds: BACKGROUND_GRID.everySeconds,
  columns: BACKGROUND_GRID.columns,
  rows: BACKGROUND_GRID.rows,
} as const;

// Bumped whenever how the map is made changes: every map's fingerprint names it.
export const BACKGROUNDS_VERSION = 1;

type Settings = typeof BACKGROUND_SETTINGS;

// ffmpeg's arguments: the footage's first video stream sampled at the grid's
// rate, area-averaged down to the grid, as raw 8-bit RGB frames. The average
// is taken in gamma space before the luminance, which slightly understates
// contrast on fine textures: a robust estimate, not a measurement per pixel.
export function backgroundArgs(input: string, output: string, settings: Settings): string[] {
  const fps = 1 / settings.everySeconds;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-vf",
    `fps=${fps},scale=${settings.columns}:${settings.rows}:flags=area,format=rgb24`,
    "-f",
    "rawvideo",
    output,
  ];
}

// Raw RGB frames as the stored map: each cell's WCAG relative luminance,
// quantised to a byte, one base64 string per frame. A trailing partial frame
// (or no frame at all) is an error.
export function mapFromRaw(bytes: Uint8Array, settings: Settings): BackgroundMap {
  const cells = settings.columns * settings.rows;
  const frameBytes = cells * 3;
  if (bytes.length === 0 || bytes.length % frameBytes !== 0) {
    throw new Error(
      `backgrounds: ${bytes.length} bytes is not a whole number of ${settings.columns}x${settings.rows} RGB frames`,
    );
  }
  const frames: string[] = [];
  for (let start = 0; start < bytes.length; start += frameBytes) {
    const out = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell += 1) {
      const at = start + cell * 3;
      out[cell] = luminanceByte(rgbLuminance(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!));
    }
    frames.push(Buffer.from(out).toString("base64"));
  }
  return {
    version: 1,
    everySeconds: settings.everySeconds,
    columns: settings.columns,
    rows: settings.rows,
    frames,
  };
}

// The stored file's text (and the committed fixture map's).
export function backgroundsJson(map: BackgroundMap): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}
