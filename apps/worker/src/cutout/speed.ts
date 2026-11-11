import type { Counter, Meter } from "@opentelemetry/api";
import { MASK_TOOL_VERSION } from "./mask-tool.ts";

// The cut-out speed metrics (app_docs/measurement.md, Cut-out speed). They go
// to Prometheus through OpenTelemetry, never to the database: the owner keeps
// the tool's speed as a metric. Each counter carries the mask tool's version.
export const VIDEO_METRIC = "cutout.video";
export const WORK_METRIC = "cutout.work";
export const SPEED_UNIT = "s";
export const VERSION_ATTRIBUTE = "mask_tool_version";

interface SpeedCounters {
  // Seconds of footage cut out (the made spans' lengths).
  video: Counter;
  // Wall seconds of the cut-out step that made them.
  work: Counter;
}

const counters = new WeakMap<Meter, SpeedCounters>();

function countersOf(meter: Meter): SpeedCounters {
  let made = counters.get(meter);
  if (!made) {
    made = {
      video: meter.createCounter(VIDEO_METRIC, {
        unit: SPEED_UNIT,
        description: "Seconds of footage cut out, by mask tool version",
      }),
      work: meter.createCounter(WORK_METRIC, {
        unit: SPEED_UNIT,
        description: "Wall seconds of the cut-out step that made masks, by mask tool version",
      }),
    };
    counters.set(meter, made);
  }
  return made;
}

function versionAttributes(): Record<string, string> {
  return { [VERSION_ATTRIBUTE]: String(MASK_TOOL_VERSION) };
}

// Before a step that makes masks: both counters of this tool version start at
// zero. Prometheus needs two samples to compute an increase, so the zero is the
// baseline the step's own sample is measured from (a one-shot process has no
// other sample of its own).
export function startCutoutSpeed(meter: Meter): void {
  const { video, work } = countersOf(meter);
  video.add(0, versionAttributes());
  work.add(0, versionAttributes());
}

// After a successful step that made at least one mask.
export function recordCutoutSpeed(meter: Meter, videoSeconds: number, workSeconds: number): void {
  const { video, work } = countersOf(meter);
  video.add(videoSeconds, versionAttributes());
  work.add(workSeconds, versionAttributes());
}

// The Prometheus name of an OpenTelemetry instrument through the otel-lgtm
// OTLP receiver (Prometheus's OTLP translation with suffixes): dots become
// underscores, the unit gets its long name (s -> seconds), and a counter gets
// _total.
export function prometheusCounterName(name: string, unit: string): string {
  const unitName = unit === "s" ? "seconds" : unit;
  return `${name.replaceAll(".", "_")}_${unitName}_total`;
}
