import type { Attributes } from "@opentelemetry/api";
import type { SupabaseClient } from "@supabase/supabase-js";

// The reel's size, carried as `reel.*` attributes on the job span and every
// step span, so step timings can be read against the reel's length
// (app_docs/measurement.md). Every value is null until the worker knows it.
export interface ReelSize {
  sourceSeconds: number | null;
  sourceBytes: number | null;
  width: number | null;
  height: number | null;
  footageSeconds: number | null;
  wordCount: number | null;
}

// What one job knows of its reel's size: read once at job start, updated when
// the pipeline learns a value (the probe, the retime), read by each span.
export interface ReelSizeHolder {
  current(): ReelSize;
  update(partial: Partial<ReelSize>): void;
}

export const UNKNOWN_SIZE: ReelSize = {
  sourceSeconds: null,
  sourceBytes: null,
  width: null,
  height: null,
  footageSeconds: null,
  wordCount: null,
};

export function createReelSizeHolder(initial: ReelSize = UNKNOWN_SIZE): ReelSizeHolder {
  let size = { ...initial };
  return {
    current: () => size,
    update(partial) {
      size = { ...size, ...partial };
    },
  };
}

interface ReelSizeRow {
  source_bytes: number | null;
  source_seconds: number | string | null;
  source_width: number | null;
  source_height: number | null;
  footage_seconds: number | string | null;
  word_count: number | null;
}

// numeric columns may come back as strings.
function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The reel's size columns, one select; a missing reel or a failed read is an
// unknown size (a span attribute never fails a job).
export async function readReelSize(db: SupabaseClient, reelId: string): Promise<ReelSize> {
  const { data, error } = await db
    .from("reels")
    .select(
      "source_bytes, source_seconds, source_width, source_height, footage_seconds, word_count",
    )
    .eq("id", reelId)
    .maybeSingle<ReelSizeRow>();
  if (error || !data) return UNKNOWN_SIZE;
  return {
    sourceSeconds: toNumber(data.source_seconds),
    sourceBytes: toNumber(data.source_bytes),
    width: data.source_width,
    height: data.source_height,
    footageSeconds: toNumber(data.footage_seconds),
    wordCount: data.word_count,
  };
}

const ATTRIBUTE_NAMES: Record<keyof ReelSize, string> = {
  sourceSeconds: "reel.source_seconds",
  sourceBytes: "reel.source_bytes",
  width: "reel.width",
  height: "reel.height",
  footageSeconds: "reel.footage_seconds",
  wordCount: "reel.word_count",
};

// The `reel.*` attributes of the known values; nulls are skipped.
export function reelSizeAttributes(size: ReelSize): Attributes {
  const attributes: Attributes = {};
  for (const [key, name] of Object.entries(ATTRIBUTE_NAMES) as [keyof ReelSize, string][]) {
    const value = size[key];
    if (value !== null) attributes[name] = value;
  }
  return attributes;
}
