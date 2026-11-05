import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type PhotoLook, luminanceByte, rgbLuminance } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import type { Tool } from "../step-runner.ts";
import type { LibraryPhoto } from "./photo-store.ts";

// The grid a photo's thumbnail is scaled down to before its border is read.
const EDGE_GRID = 8;

// ffmpeg's arguments: the thumbnail area-averaged down to the grid, as raw
// 8-bit RGB (the background map's way, so the two compare).
export function photoEdgeArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${EDGE_GRID}:${EDGE_GRID}:flags=area,format=rgb24`,
    "-f",
    "rawvideo",
    output,
  ];
}

// The WCAG relative luminance (0 to 1) along a photo's border: the median of
// the grid's outer cells, quantised like the background map. Anything but a
// whole grid is an error.
export function edgeLuminance(bytes: Uint8Array): number {
  const cells = EDGE_GRID * EDGE_GRID;
  if (bytes.length !== cells * 3) {
    throw new Error(
      `photo edge: ${bytes.length} bytes is not one ${EDGE_GRID}x${EDGE_GRID} RGB frame`,
    );
  }
  const border: number[] = [];
  for (let row = 0; row < EDGE_GRID; row += 1) {
    for (let col = 0; col < EDGE_GRID; col += 1) {
      if (row > 0 && row < EDGE_GRID - 1 && col > 0 && col < EDGE_GRID - 1) continue;
      const at = (row * EDGE_GRID + col) * 3;
      border.push(luminanceByte(rgbLuminance(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!)));
    }
  }
  border.sort((a, b) => a - b);
  return border[Math.floor((border.length - 1) / 2)]! / 255;
}

export interface PhotoLooksRun {
  library: readonly LibraryPhoto[];
  storage: Storage;
  // The decide step's tool runner and ffmpeg.
  tool: Tool;
  ffmpeg: string;
  // A scratch folder of the step's own.
  dir: string;
  signal: AbortSignal;
}

// What the layout engine knows of each library photo: its ratio (from its
// stored size) and its edge's luminance (from its thumbnail, one small ffmpeg
// call). A photo without a size or a thumbnail, or whose thumbnail cannot be
// read, has that part left out: it takes the preset's ratio, or is not
// measured for contrast. Only a cancel stops it.
export async function photoLooks({
  library,
  storage,
  tool,
  ffmpeg,
  dir,
  signal,
}: PhotoLooksRun): Promise<Map<string, PhotoLook>> {
  const looks = new Map<string, PhotoLook>();
  for (const [index, photo] of library.entries()) {
    const look: PhotoLook = {};
    if (photo.width && photo.height && photo.width > 0 && photo.height > 0) {
      look.aspect = photo.width / photo.height;
    }
    if (photo.thumbnail_key) {
      const thumbnail = join(dir, `thumbnail-${index}.jpg`);
      const raw = join(dir, `edge-${index}.rgb`);
      try {
        if (await storage.getFile(photo.thumbnail_key, thumbnail, { signal })) {
          await tool({ file: ffmpeg, args: photoEdgeArgs(thumbnail, raw) });
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's scratch folder
          look.edge = edgeLuminance(new Uint8Array(await readFile(raw)));
        }
      } catch {
        // A thumbnail ffmpeg cannot read only goes unmeasured.
        signal.throwIfAborted();
      }
    }
    if (look.aspect !== undefined || look.edge !== undefined) looks.set(photo.id, look);
  }
  return looks;
}
