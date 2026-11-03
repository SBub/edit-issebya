import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Storage, assertStorageKey } from "@edit-issebya/storage";
import type { ToolPaths } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, type Tool, runToolsStep } from "../step-runner.ts";

export const STEP = "photo_images";

// The grid tile and the copy Claude Code reads and the dialog shows (a
// browser other than Safari cannot show HEIC).
export const THUMBNAIL_LONG_SIDE = 480;
export const LARGE_LONG_SIDE = 1568;
// ffmpeg's JPEG quality scale: 2 is best, 31 worst.
const JPEG_QUALITY = "3";

export interface Size {
  width: number;
  height: number;
}

// The size within `longSide` on the long side, ratio kept, never upscaled.
export function fitWithin(width: number, height: number, longSide: number): Size {
  const long = Math.max(width, height);
  if (long <= longSide) return { width, height };
  const scale = longSide / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// Where a photo's picture is in the file: one video stream (a JPEG, a PNG, a
// WebP, a one-tile HEIC), or a HEIC tile grid ffmpeg has to put together.
export type PhotoSource =
  | { kind: "stream"; index: number }
  | {
      kind: "grid";
      tiles: { index: number; x: number; y: number }[];
      crop: { x: number; y: number } & Size;
    };

export interface PhotoProbe extends Size {
  source: PhotoSource;
  // Degrees the picture turns on screen (0, 90, 180 or 270).
  rotation: number;
}

export function photoProbeArgs(path: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_streams", "-show_stream_groups", path];
}

interface RawSideData {
  rotation?: number;
}

interface RawStream {
  index?: number;
  codec_type?: string;
  width?: number;
  height?: number;
  side_data_list?: RawSideData[];
  tags?: { rotate?: string };
}

interface RawGroup {
  type?: string;
  components?: {
    width?: number;
    height?: number;
    horizontal_offset?: number;
    vertical_offset?: number;
    side_data_list?: RawSideData[];
    subcomponents?: {
      stream_index?: number;
      tile_horizontal_offset?: number;
      tile_vertical_offset?: number;
    }[];
  }[];
}

// 0, 90, 180 or 270 from a display matrix (or the older `rotate` tag); ffmpeg
// reports the matrix's counter-clockwise angle, the screen turns clockwise.
function rotationOf(sideData: RawSideData[] | undefined, rotateTag?: string): number {
  const raw = sideData?.find((data) => typeof data.rotation === "number")?.rotation;
  const degrees = raw !== undefined ? -raw : Number(rotateTag ?? 0);
  if (!Number.isFinite(degrees)) return 0;
  return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function turned({ width, height }: Size, rotation: number): Size {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

// The picture's size on screen and where it is, from ffprobe's JSON: a tile
// grid group wins over its tiles; otherwise the first video stream. A file
// with neither is not a photo ffmpeg can read.
export function parsePhotoProbe(json: string): PhotoProbe {
  const raw = JSON.parse(json) as { streams?: RawStream[]; stream_groups?: RawGroup[] };
  const grid = raw.stream_groups?.find((group) => group.type === "Tile Grid")?.components?.[0];
  if (grid && positive(grid.width) && positive(grid.height) && grid.subcomponents?.length) {
    const tiles = grid.subcomponents.map((tile) => ({
      index: tile.stream_index ?? -1,
      x: tile.tile_horizontal_offset ?? 0,
      y: tile.tile_vertical_offset ?? 0,
    }));
    if (tiles.some((tile) => tile.index < 0)) throw new Error("photo: a tile has no stream");
    const rotation = rotationOf(grid.side_data_list);
    const crop = {
      x: grid.horizontal_offset ?? 0,
      y: grid.vertical_offset ?? 0,
      width: grid.width,
      height: grid.height,
    };
    return { ...turned(crop, rotation), rotation, source: { kind: "grid", tiles, crop } };
  }
  const video = raw.streams?.find((stream) => stream.codec_type === "video");
  if (!video || !positive(video.width) || !positive(video.height)) {
    throw new Error("photo: no picture in the file");
  }
  const rotation = rotationOf(video.side_data_list, video.tags?.rotate);
  return {
    ...turned({ width: video.width, height: video.height }, rotation),
    rotation,
    source: { kind: "stream", index: video.index ?? 0 },
  };
}

// The filter that turns a grid's picture on screen; a single stream is
// turned by ffmpeg itself (autorotate).
function turnFilter(rotation: number): string[] {
  if (rotation === 90) return ["transpose=clock"];
  if (rotation === 180) return ["hflip", "vflip"];
  if (rotation === 270) return ["transpose=cclock"];
  return [];
}

// One ffmpeg call: the picture, scaled to `size`, as one JPEG frame.
export function photoImageArgs(input: string, probe: PhotoProbe, size: Size, output: string) {
  const scale = `scale=${size.width}:${size.height}`;
  const head = ["-hide_banner", "-v", "error", "-y", "-i", input];
  const tail = ["-frames:v", "1", "-q:v", JPEG_QUALITY, "-update", "1", output];
  const { source } = probe;
  if (source.kind === "stream") {
    return [...head, "-map", `0:${source.index}`, "-vf", scale, ...tail];
  }
  const { tiles, crop } = source;
  const inputs = tiles.map((tile) => `[0:${tile.index}]`).join("");
  const filters = [
    ...(tiles.length > 1
      ? [`xstack=inputs=${tiles.length}:layout=${tiles.map((t) => `${t.x}_${t.y}`).join("|")}`]
      : []),
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    ...turnFilter(probe.rotation),
    scale,
  ];
  return [
    ...head,
    "-filter_complex",
    `${inputs}${filters.join(",")}[photo]`,
    "-map",
    "[photo]",
    ...tail,
  ];
}

// `<prefix>library/<photo id>/<file>`.
export function photoFileKey(prefix: string, photoId: string, file: string): string {
  return assertStorageKey(`${prefix}library/${photoId}/${file}`);
}

export interface PhotoImages extends Size {
  thumbnailKey: string;
  largeKey: string;
}

export interface PhotoImagesRun {
  ctx: StepContext;
  // The job's recording storage: both copies get their `stored_files` rows.
  storage: Storage;
  tools: Pick<ToolPaths, "ffmpeg" | "ffprobe">;
  keyPrefix: string;
  // The job's scratch folder.
  scratchDir: string;
  photoId: string;
  originalKey: string;
  // Tests pass a fake; otherwise the real child process.
  spawnTool?: SpawnTool;
}

// The `photo_images` step: the original downloaded into the job's scratch,
// probed for its size, then the grid thumbnail and the large JPEG copy, both
// stored once under the worker's prefix (rebuildable). Answers the picture's
// size and both keys.
export async function runPhotoImages({
  ctx,
  storage,
  tools,
  keyPrefix,
  scratchDir,
  photoId,
  originalKey,
  spawnTool,
}: PhotoImagesRun): Promise<PhotoImages> {
  const dir = join(scratchDir, "photo");
  const ext = originalKey.slice(originalKey.lastIndexOf("."));
  const original = join(dir, `original${ext}`);
  const thumbnail = join(dir, "thumbnail.jpg");
  const large = join(dir, "large.jpg");
  const thumbnailKey = photoFileKey(keyPrefix, photoId, "thumbnail.jpg");
  const largeKey = photoFileKey(keyPrefix, photoId, "large.jpg");
  let result: PhotoImages | null = null;
  await runToolsStep(
    ctx,
    {
      name: STEP,
      inputs: [original],
      outputs: [thumbnail, large],
      sizeOf: "out",
      async work(tool: Tool) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
        await mkdir(dir, { recursive: true });
        const found = await storage.getFile(originalKey, original, { signal: ctx.signal });
        if (!found) throw new Error(`${STEP}: original missing at ${originalKey}`);
        const probe = parsePhotoProbe(
          await tool({ file: tools.ffprobe, args: photoProbeArgs(original) }),
        );
        const small = fitWithin(probe.width, probe.height, THUMBNAIL_LONG_SIDE);
        const big = fitWithin(probe.width, probe.height, LARGE_LONG_SIDE);
        await tool({ file: tools.ffmpeg, args: photoImageArgs(original, probe, small, thumbnail) });
        await tool({ file: tools.ffmpeg, args: photoImageArgs(original, probe, big, large) });
        ctx.signal.throwIfAborted();
        await storage.putFileIfAbsent(thumbnailKey, thumbnail, { contentType: "image/jpeg" });
        await storage.putFileIfAbsent(largeKey, large, { contentType: "image/jpeg" });
        result = { width: probe.width, height: probe.height, thumbnailKey, largeKey };
        return {
          what: `${probe.width}x${probe.height}, thumbnail ${small.width}x${small.height}`,
        };
      },
    },
    spawnTool,
  );
  if (!result) throw new Error(`${STEP}: no result`);
  return result;
}

// The large copy's local path after `runPhotoImages` ran in this scratch.
export function largeCopyPath(scratchDir: string): string {
  return join(scratchDir, "photo", "large.jpg");
}
