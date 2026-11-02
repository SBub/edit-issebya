import { FootageRefused } from "../failure.ts";
import type { Tool } from "../step-runner.ts";
import { type Probe, parseProbe, probeArgs } from "./probe.ts";
import type { ToolPaths } from "./tools.ts";

// The one place the footage limits live; the other rules (a video, with
// sound, vertical) are yes or no.
export const FOOTAGE_LIMITS = { maxSeconds: 90 } as const;

export const NOT_A_VIDEO = "This file is not a video. Upload a clip from your phone (MP4 or MOV).";
export const NO_SOUND = "This clip has no sound. The studio needs your voice to make the captions.";

function notVerticalMessage(width: number, height: number): string {
  return `This clip is ${width} x ${height}, not vertical. The studio takes vertical clips only.`;
}

function tooLongMessage(seconds: number): string {
  return `This clip is ${formatDuration(seconds)}; the studio takes up to ${formatDuration(FOOTAGE_LIMITS.maxSeconds)}.`;
}

// The size the player shows: width and height swapped for a quarter turn.
export function displaySize(probe: Probe): { width: number; height: number } {
  const { width, height, rotation } = probe.video;
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// Whole seconds, rounded up: `2 minutes 10 seconds`, `1 minute`, `45 seconds`.
export function formatDuration(seconds: number): string {
  const total = Math.ceil(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return plural(rest, "second");
  if (rest === 0) return plural(minutes, "minute");
  return `${plural(minutes, "minute")} ${plural(rest, "second")}`;
}

// An image (`image2`, `png_pipe`, `jpeg_pipe`, ...) is not a video, whatever
// streams it reports.
function isImageContainer(formatName: string | null): boolean {
  if (!formatName) return false;
  return formatName.split(",").some((name) => name === "image2" || name.endsWith("_pipe"));
}

// The human reason the footage is refused, or null when it is accepted. The
// first failing rule wins: a video, with sound, vertical, at most 90 seconds.
export function footageRefusal(probe: Probe | null): string | null {
  if (!probe || isImageContainer(probe.formatName)) return NOT_A_VIDEO;
  if (!probe.audio) return NO_SOUND;
  const { width, height } = displaySize(probe);
  if (!(height > width)) return notVerticalMessage(width, height);
  if (probe.durationSeconds > FOOTAGE_LIMITS.maxSeconds) {
    return tooLongMessage(probe.durationSeconds);
  }
  return null;
}

// `0:24`.
function clock(seconds: number): string {
  const total = Math.ceil(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// sh's codes for a tool it could not find or execute: a broken worker, never
// a verdict on the file.
const NOT_STARTED = new Set([126, 127]);

// ffprobe ran and exited non-zero: it could not read the file.
function unreadable(error: unknown): boolean {
  const fields = (error ?? {}) as { exitCode?: unknown; code?: unknown };
  const exit = typeof fields.exitCode === "number" ? fields.exitCode : fields.code;
  return typeof exit === "number" && exit !== 0 && !NOT_STARTED.has(exit);
}

// Probes the downloaded source. A file ffprobe cannot read, or whose JSON
// says it is not a video, is refused like any other bad footage, never a step
// failure; a refusal throws FootageRefused with the human message.
export async function checkFootage({
  tool,
  tools,
  path,
}: {
  tool: Tool;
  tools: ToolPaths;
  path: string;
}): Promise<{ what: string }> {
  let probe: Probe | null;
  try {
    probe = parseProbe(await tool({ file: tools.ffprobe, args: probeArgs(path) }));
  } catch (error) {
    if (error instanceof SyntaxError || unreadable(error)) probe = null;
    else if (error instanceof Error && error.message.startsWith("probe:")) probe = null;
    else throw error;
  }
  const refusal = footageRefusal(probe);
  if (refusal !== null || !probe) throw new FootageRefused(refusal ?? NOT_A_VIDEO);
  const { width, height } = displaySize(probe);
  return { what: `footage checked, ${clock(probe.durationSeconds)}, ${width} x ${height}` };
}
