import { type Edit, EXPORT_FPS, type Transcript, resolveTimeline } from "@edit-issebya/edit";

// Which way a version is exported (app_docs/export.md). `composite`: three
// small HyperFrames pages and one ffmpeg pass that blends them over the
// footage. `single`: one HyperFrames call that screenshots every frame, the
// footage included; slower, and it handles every version.
export type RenderPath = "composite" | "single";

// How the composite takes the footage. `match`: through the single call's own
// JPEG step first, so every frame matches the single call's export within the
// guardrail's bound. `clean`: straight from the decoder (faster, a smaller
// file, closer to the source footage, a hair further from the single call's
// export). Not the default: see app_docs/export.md.
export type RenderMode = "match" | "clean";

export interface RenderSettings {
  path: RenderPath;
  mode: RenderMode;
}

type Env = Record<string, string | undefined>;

function oneOf<T extends string>(env: Env, name: string, values: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!(values as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be ${values.join(" or ")}, got ${raw}`);
  }
  return raw as T;
}

// WORKER_RENDER_PATH (default `composite`) and WORKER_RENDER_MODE (default
// `match`). Another value is refused, never guessed.
export function renderSettings(env: Env = process.env): RenderSettings {
  return {
    path: oneOf(env, "WORKER_RENDER_PATH", ["composite", "single"] as const, "composite"),
    mode: oneOf(env, "WORKER_RENDER_MODE", ["match", "clean"] as const, "match"),
  };
}

// What the route and the composite need to know of a media file (one ffprobe
// call, `parseMediaFacts`).
export interface MediaFacts {
  width: number;
  height: number;
  // ffprobe's r_frame_rate and avg_frame_rate (`30/1`).
  rate: string;
  avgRate: string;
  // The video stream's frame count; NaN when the container does not say.
  frames: number;
  range: "tv" | "pc";
  pixFmt: string;
  hasAudio: boolean;
}

// The first reel length the composite does not take, in seconds. From 120 s on
// HyperFrames encodes the sound in segments whose cut points depend on the
// padded length, so the sound page's packets may differ near the cuts: the
// sound's identity is not verified there.
export const COMPOSITE_MAX_SECONDS = 120;

// Why a version goes to the single call.
export type SingleReason =
  // WORKER_RENDER_PATH=single.
  | "setting"
  // No footage clip, or several.
  | "footage_clips"
  // The footage clip has a style, or hidden spans (the page fades it).
  | "footage_style"
  | "footage_hidden"
  // The footage clip does not run from 0 to the reel's end.
  | "footage_span"
  // COMPOSITE_MAX_SECONDS or longer.
  | "long_reel"
  // The footage is not 30 fps at a constant rate, or its frames are not counted.
  | "footage_fps"
  // The footage is not 8-bit 4:2:0.
  | "footage_format"
  // The footage has no sound stream.
  | "no_audio"
  // A mask is not 30 fps, or its frames are not counted.
  | "mask_fps"
  // The masks differ in size or range.
  | "mask_sizes";

export type RenderRoute =
  { path: "composite"; mode: RenderMode } | { path: "single"; reason: SingleReason };

const RATE = `${EXPORT_FPS}/1`;
const FOOTAGE_FORMATS = new Set(["yuv420p", "yuvj420p"]);

function constantRate(facts: MediaFacts): boolean {
  return (
    facts.rate === RATE &&
    facts.avgRate === RATE &&
    Number.isInteger(facts.frames) &&
    facts.frames > 0
  );
}

export interface RouteInput {
  settings: RenderSettings;
  edit: Edit;
  transcript: Transcript;
  // The probed footage and masks (one per mask span, in order). Left out, only
  // the edit's own rules are judged: the first look, before any probe, and all
  // there is under the render double.
  footage?: MediaFacts;
  masks?: readonly MediaFacts[];
}

// The route of one version: the composite when it handles the version, else
// the single call with the reason. A pure function of the settings, the edit
// and the probed files. The composite handles one plain footage clip over the
// whole reel, at 30 fps with sound, under 120 s, with masks of one size.
export function renderRoute({
  settings,
  edit,
  transcript,
  footage,
  masks,
}: RouteInput): RenderRoute {
  const single = (reason: SingleReason): RenderRoute => ({ path: "single", reason });
  if (settings.path === "single") return single("setting");
  const clips = edit.tracks.footage;
  const clip = clips[0];
  if (clips.length !== 1 || !clip) return single("footage_clips");
  if (clip.style && Object.keys(clip.style).length > 0) return single("footage_style");
  if ((clip.hidden ?? []).length > 0) return single("footage_hidden");
  const span = resolveTimeline(edit, transcript).get(clip.id);
  if (!span || Math.abs(span.start) > 0.0005 || Math.abs(span.end - edit.duration) > 0.0005) {
    return single("footage_span");
  }
  if (!(edit.duration < COMPOSITE_MAX_SECONDS)) return single("long_reel");
  if (footage) {
    if (!constantRate(footage)) return single("footage_fps");
    if (!FOOTAGE_FORMATS.has(footage.pixFmt)) return single("footage_format");
    if (!footage.hasAudio) return single("no_audio");
  }
  const first = masks?.[0];
  if (masks && first) {
    if (!masks.every(constantRate)) return single("mask_fps");
    const same = (mask: MediaFacts) =>
      mask.width === first.width && mask.height === first.height && mask.range === first.range;
    if (!masks.every(same)) return single("mask_sizes");
  }
  return { path: "composite", mode: settings.mode };
}
