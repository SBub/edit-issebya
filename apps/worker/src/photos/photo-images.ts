import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Storage, assertStorageKey } from "@edit-issebya/storage";
import type { ToolPaths } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, type Tool, runToolsStep } from "../step-runner.ts";
import { NO_TURN, type Turn, exifTurn, readHeifTurn } from "./heif-turn.ts";

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

// The picture upright: `width` and `height` are its size on screen, after the
// turn; `source` is the stored picture, before it.
export interface PhotoProbe extends Size, Turn {
  source: PhotoSource;
}

// Only what parsePhotoProbe reads: an iPhone HEIC has a stream per tile, and
// every field of every stream is several times the step runner's stdout cap.
const PROBE_FIELDS = {
  stream: ["index", "codec_type", "width", "height"],
  stream_tags: ["rotate"],
  stream_side_data: ["rotation"],
  stream_group: ["type"],
  stream_group_component: ["width", "height", "horizontal_offset", "vertical_offset"],
  subcomponent: ["stream_index", "tile_horizontal_offset", "tile_vertical_offset"],
  frame: ["stream_index"],
  frame_tags: ["Orientation"],
  frame_side_data: ["rotation"],
};
// ffprobe's `-show_entries` value: `section=field,field:section=field`.
const PROBE_ENTRIES = Object.entries(PROBE_FIELDS)
  .map(([section, fields]) => `${section}=${fields.join(",")}`)
  .join(":");

// The probe's answer is under 1 KB for a JPEG and some 20 KB for an iPhone
// HEIC of 48 tile streams; the cap leaves room for a file with far more.
// Over it the call fails.
export const PROBE_STDOUT_BYTES = 4 * 1024 * 1024;

// The streams, the tile grids and the first frame (`%+#1`: one packet is read):
// a JPEG says how it is turned on its frame only (the EXIF Orientation tag).
export function photoProbeArgs(path: string): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json=compact=1",
    "-read_intervals",
    "%+#1",
    "-show_entries",
    PROBE_ENTRIES,
    path,
  ];
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

interface RawFrame {
  stream_index?: number;
  side_data_list?: RawSideData[];
  tags?: { Orientation?: string };
}

interface RawGroup {
  type?: string;
  components?: {
    width?: number;
    height?: number;
    horizontal_offset?: number;
    vertical_offset?: number;
    subcomponents?: {
      stream_index?: number;
      tile_horizontal_offset?: number;
      tile_vertical_offset?: number;
    }[];
  }[];
}

// The nearest of 0, 90, 180 and 270 degrees clockwise; 0 for no number.
function quarterTurn(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

// The clockwise turn of a display matrix (ffmpeg reports its
// counter-clockwise angle); null without one.
function matrixRotation(sideData: RawSideData[] | undefined): number | null {
  const raw = sideData?.find((data) => typeof data.rotation === "number")?.rotation;
  return raw === undefined ? null : quarterTurn(-raw);
}

// How one stream's picture is turned: its frame's EXIF Orientation tag (a
// JPEG; the only place a mirror is read from), else the frame's display
// matrix, else the stream's (a video, a one-picture HEIC), else the older
// `rotate` tag.
function streamTurn(stream: RawStream, frames: RawFrame[] | undefined): Turn {
  const frame = frames?.find((one) => (one.stream_index ?? 0) === (stream.index ?? 0));
  const orientation = Number(frame?.tags?.Orientation);
  if (Number.isInteger(orientation) && orientation >= 1 && orientation <= 8) {
    return exifTurn(orientation);
  }
  const rotation =
    matrixRotation(frame?.side_data_list) ??
    matrixRotation(stream.side_data_list) ??
    quarterTurn(Number(stream.tags?.rotate ?? 0));
  return { mirrored: false, rotation };
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function turned({ width, height }: Size, rotation: number): Size {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

// The picture's size on screen and where it is, from ffprobe's JSON: a tile
// grid group wins over its tiles; otherwise the first video stream. A file
// with neither is not a photo ffmpeg can read. `heif` is the turn the file's
// own HEIF boxes ask for (readHeifTurn; null for any other file): it is the
// turn of a HEIC, grid or not, because ffprobe prints none for a grid.
export function parsePhotoProbe(json: string, heif: Turn | null = null): PhotoProbe {
  const raw = JSON.parse(json) as {
    streams?: RawStream[];
    stream_groups?: RawGroup[];
    frames?: RawFrame[];
  };
  const grid = raw.stream_groups?.find((group) => group.type === "Tile Grid")?.components?.[0];
  if (grid && positive(grid.width) && positive(grid.height) && grid.subcomponents?.length) {
    const tiles = grid.subcomponents.map((tile) => ({
      index: tile.stream_index ?? -1,
      x: tile.tile_horizontal_offset ?? 0,
      y: tile.tile_vertical_offset ?? 0,
    }));
    if (tiles.some((tile) => tile.index < 0)) throw new Error("photo: a tile has no stream");
    const turn = heif ?? NO_TURN;
    const crop = {
      x: grid.horizontal_offset ?? 0,
      y: grid.vertical_offset ?? 0,
      width: grid.width,
      height: grid.height,
    };
    return { ...turned(crop, turn.rotation), ...turn, source: { kind: "grid", tiles, crop } };
  }
  const video = raw.streams?.find((stream) => stream.codec_type === "video");
  if (!video || !positive(video.width) || !positive(video.height)) {
    throw new Error("photo: no picture in the file");
  }
  const turn = heif ?? streamTurn(video, raw.frames);
  return {
    ...turned({ width: video.width, height: video.height }, turn.rotation),
    ...turn,
    source: { kind: "stream", index: video.index ?? 0 },
  };
}

// The filters that put the stored picture upright. ffmpeg never turns it
// itself (`-noautorotate`): ffmpeg 7.1 turns by a stream's display matrix but
// not by a JPEG's Orientation tag, ffmpeg 8 by both, and neither turns a grid
// put together here, so one rule for every file and no picture turned twice.
function turnFilters({ mirrored, rotation }: Turn): string[] {
  // A mirror and a half turn is a flip top to bottom.
  if (rotation === 180) return mirrored ? ["vflip"] : ["hflip", "vflip"];
  return [
    ...(mirrored ? ["hflip"] : []),
    ...(rotation === 90 ? ["transpose=clock"] : []),
    ...(rotation === 270 ? ["transpose=cclock"] : []),
  ];
}

// One ffmpeg call: the picture, upright, scaled to `size`, as one JPEG frame.
export function photoImageArgs(input: string, probe: PhotoProbe, size: Size, output: string) {
  const scale = `scale=${size.width}:${size.height}`;
  const head = ["-hide_banner", "-v", "error", "-y", "-noautorotate", "-i", input];
  const tail = ["-frames:v", "1", "-q:v", JPEG_QUALITY, "-update", "1", output];
  const { source } = probe;
  if (source.kind === "stream") {
    const filters = [...turnFilters(probe), scale];
    return [...head, "-map", `0:${source.index}`, "-vf", filters.join(","), ...tail];
  }
  const { tiles, crop } = source;
  const inputs = tiles.map((tile) => `[0:${tile.index}]`).join("");
  const filters = [
    ...(tiles.length > 1
      ? [`xstack=inputs=${tiles.length}:layout=${tiles.map((t) => `${t.x}_${t.y}`).join("|")}`]
      : []),
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    ...turnFilters(probe),
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
// probed for its size and how it is turned, then the grid thumbnail and the
// large JPEG copy, both upright and stored once under the worker's prefix
// (rebuildable). Answers the upright picture's size and both keys.
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
          await tool({
            file: tools.ffprobe,
            args: photoProbeArgs(original),
            maxStdoutBytes: PROBE_STDOUT_BYTES,
          }),
          await readHeifTurn(original),
        );
        const small = fitWithin(probe.width, probe.height, THUMBNAIL_LONG_SIDE);
        const big = fitWithin(probe.width, probe.height, LARGE_LONG_SIDE);
        await tool({
          file: tools.ffmpeg,
          args: photoImageArgs(original, probe, small, thumbnail),
          ignoreStdout: true,
        });
        await tool({
          file: tools.ffmpeg,
          args: photoImageArgs(original, probe, big, large),
          ignoreStdout: true,
        });
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
