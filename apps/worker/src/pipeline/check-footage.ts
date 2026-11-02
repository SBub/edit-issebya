import { join } from "node:path";
import { toolExitOf } from "../failures.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { PipelineStep } from "./definition.ts";
import { writeAtomic } from "./atomic.ts";
import { FOOTAGE_LIMITS, FOOTAGE_MESSAGES, formatClipLength } from "./footage-limits.ts";
import { type RawStream, probeArgs } from "./probe.ts";

const CHECK_FOOTAGE_VERSION = 1;
// Bumped when the facts below change shape; the verdict is not part of the
// fingerprint, so a changed limit judges the stored facts again without a probe.
const CHECK_FOOTAGE_SETTINGS = { facts: 1 };
export const FOOTAGE_FILE = "footage.json";

// sh's codes for a tool it could not find or execute: a missing ffprobe, never
// a verdict on the clip.
const NOT_STARTED = new Set([126, 127]);

type Rotation = 0 | 90 | 180 | 270;

// What the footage check knows about the clip, normalised from one ffprobe call.
export interface FootageFacts {
  readable: boolean;
  formatName: string | null;
  video: { width: number; height: number; rotation: Rotation } | null;
  audio: boolean;
  durationSeconds: number | null;
}

const UNREADABLE: FootageFacts = {
  readable: false,
  formatName: null,
  video: null,
  audio: false,
  durationSeconds: null,
};

function normaliseRotation(degrees: number): Rotation {
  const quarter = Math.round(degrees / 90);
  return ((((quarter % 4) + 4) % 4) * 90) as Rotation;
}

function rotationOf(stream: RawStream): Rotation {
  const matrix = stream.side_data_list?.find((entry) => typeof entry.rotation === "number");
  if (matrix && typeof matrix.rotation === "number") return normaliseRotation(matrix.rotation);
  const tag = Number(stream.tags?.rotate);
  return Number.isFinite(tag) ? normaliseRotation(tag) : 0;
}

// ffprobe's JSON as facts; null (ffprobe refused the file) or text that is not
// a probe result is an unreadable file. The video is the first video stream
// that is not a cover image.
export function footageFacts(json: string | null): FootageFacts {
  if (json === null) return UNREADABLE;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return UNREADABLE;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return UNREADABLE;
  const probe = raw as {
    streams?: RawStream[];
    format?: { format_name?: string; duration?: string };
  };
  if (!Array.isArray(probe.streams) || !probe.format) return UNREADABLE;
  const video = probe.streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  const duration = Number(probe.format.duration);
  return {
    readable: true,
    formatName: probe.format.format_name ?? null,
    video: video
      ? { width: video.width ?? 0, height: video.height ?? 0, rotation: rotationOf(video) }
      : null,
    audio: probe.streams.some((stream) => stream.codec_type === "audio"),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

// The kept `footage.json` read back; anything that is not the facts' shape throws.
export function storedFacts(bytes: Uint8Array): FootageFacts {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<FootageFacts> | null;
  if (
    !value ||
    typeof value.readable !== "boolean" ||
    typeof value.audio !== "boolean" ||
    !("video" in value) ||
    !("durationSeconds" in value) ||
    !("formatName" in value)
  ) {
    throw new Error(`check_footage: ${FOOTAGE_FILE} is not footage facts`);
  }
  return value as FootageFacts;
}

function isStillImage(formatName: string | null): boolean {
  return formatName === "image2" || (formatName?.endsWith("_pipe") ?? false);
}

// Every rule the clip breaks, one sentence each, in order; null when the clip
// is accepted. A file that is not a video gets that sentence alone.
export function footageRefusal(facts: FootageFacts): string | null {
  const { video, durationSeconds } = facts;
  if (
    !facts.readable ||
    !video ||
    video.width <= 0 ||
    video.height <= 0 ||
    isStillImage(facts.formatName) ||
    durationSeconds === null
  ) {
    return FOOTAGE_MESSAGES.notVideo;
  }
  const sentences: string[] = [];
  if (!facts.audio) sentences.push(FOOTAGE_MESSAGES.noSound);
  const turned = video.rotation === 90 || video.rotation === 270;
  const width = turned ? video.height : video.width;
  const height = turned ? video.width : video.height;
  if (height <= width) {
    sentences.push(
      FOOTAGE_MESSAGES.notVertical(height === width ? "square" : "landscape", width, height),
    );
  }
  if (durationSeconds > FOOTAGE_LIMITS.maxDurationSeconds) {
    sentences.push(FOOTAGE_MESSAGES.tooLong(durationSeconds));
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}

// `footage checked: 1080 x 1920, 42 seconds, sound`, as the owner sees the clip.
function checkedWhat(facts: FootageFacts): string {
  const parts: string[] = [];
  if (facts.video) {
    const turned = facts.video.rotation === 90 || facts.video.rotation === 270;
    const width = turned ? facts.video.height : facts.video.width;
    const height = turned ? facts.video.width : facts.video.height;
    parts.push(`${width} x ${height}`);
  }
  if (facts.durationSeconds !== null) parts.push(formatClipLength(facts.durationSeconds));
  parts.push(facts.audio ? "sound" : "no sound");
  return facts.readable ? `footage checked: ${parts.join(", ")}` : "footage checked: unreadable";
}

// The first step: probes the upload before any heavy step and keeps the facts,
// so a retry (and CI, which has no ffprobe) judges them without probing again.
// The verdict is the gate, read by the pipeline runner on a run and on a hit.
export const checkFootage: PipelineStep<typeof CHECK_FOOTAGE_SETTINGS> = {
  name: "check_footage",
  version: CHECK_FOOTAGE_VERSION,
  settings: CHECK_FOOTAGE_SETTINGS,
  reelStatus: "checking_footage",
  outputs: [{ file: FOOTAGE_FILE, retention: "kept" }],
  reusedWhat: "footage checked",
  inputs: (source) => [{ ref: { source }, as: "source" }],
  async run({ tool, tools, dir, files }) {
    let json: string | null;
    try {
      json = await tool({ file: tools.ffprobe, args: probeArgs(files.source!) });
    } catch (error) {
      // ffprobe answered "not a file I can read"; a signal (transient) or a
      // missing ffprobe is no verdict on the clip.
      const exit = toolExitOf(error);
      if (exit === null || typeof exit.code !== "number" || NOT_STARTED.has(exit.code)) {
        throw error;
      }
      json = null;
    }
    const facts = footageFacts(json);
    await writeAtomic(join(dir, FOOTAGE_FILE), canonicalJson(facts));
    return { what: checkedWhat(facts) };
  },
  gate(outputs) {
    const bytes = outputs[FOOTAGE_FILE];
    if (!bytes) throw new Error(`check_footage: no ${FOOTAGE_FILE} to judge`);
    return footageRefusal(storedFacts(bytes));
  },
};
