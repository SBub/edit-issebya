import { assertStorageKey } from "@edit-issebya/storage";

// The export's HyperFrames flags, fixed:
// - delivery quality: TikTok and Instagram recompress every upload, and a
//   cleaner source keeps caption text and the cut-out's edges sharp after it;
// - three software workers (no browser GPU): faster here than the GPU with one
//   worker, and the same frames on a cloud machine without a GPU;
// - SDR: the preview and the platforms are SDR;
// - no best effort: a missing font or an unready video fails the step instead
//   of exporting a wrong frame;
// - quiet: the step log keeps the errors, not a progress bar.
const RENDER_FLAGS = [
  "--quality",
  "delivery",
  "--workers",
  "3",
  "--no-browser-gpu",
  "--sdr",
  "--no-best-effort",
  "--quiet",
] as const;

// A span of the film in seconds. Only the tools test passes one, through the
// render step's options; a job row never carries a range.
export interface RenderRange {
  start: number;
  end: number;
}

// `hyperframes render <project> -o <output>` with the fixed flags: the
// arguments after the Node binary (`cli` is the package's own entry).
export function renderArgs({
  cli,
  project,
  output,
  range,
}: {
  cli: string;
  project: string;
  output: string;
  range?: RenderRange;
}): string[] {
  return [
    cli,
    "render",
    project,
    "-o",
    output,
    ...RENDER_FLAGS,
    ...(range ? ["--start", String(range.start), "--end", String(range.end)] : []),
  ];
}

// Where an export's MP4 lives: `<prefix>exports/<reel id>/<export id>.mp4`.
export function exportKey(prefix: string, reelId: string, exportId: string): string {
  return assertStorageKey(`${prefix}exports/${reelId}/${exportId}.mp4`);
}
