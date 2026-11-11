import type { Counter, Meter } from "@opentelemetry/api";

// The head-track speed metrics (app_docs/measurement.md, Head-track speed). They
// go to Prometheus through OpenTelemetry, never to the database: the owner keeps
// the step's speed as a metric. Each counter carries the step's version.
export const VIDEO_METRIC = "head_track.video";
export const WORK_METRIC = "head_track.work";
export const SPEED_UNIT = "s";
export const VERSION_ATTRIBUTE = "head_track_version";

interface SpeedCounters {
  // Seconds of footage tracked (the samples' spacing times their count).
  video: Counter;
  // Wall seconds of the head_track step that tracked them.
  work: Counter;
}

const counters = new WeakMap<Meter, SpeedCounters>();

function countersOf(meter: Meter): SpeedCounters {
  let made = counters.get(meter);
  if (!made) {
    made = {
      video: meter.createCounter(VIDEO_METRIC, {
        unit: SPEED_UNIT,
        description: "Seconds of footage head-tracked, by head track version",
      }),
      work: meter.createCounter(WORK_METRIC, {
        unit: SPEED_UNIT,
        description: "Wall seconds of the head_track step, by head track version",
      }),
    };
    counters.set(meter, made);
  }
  return made;
}

function versionAttributes(version: number): Record<string, string> {
  return { [VERSION_ATTRIBUTE]: String(version) };
}

// Before the step's first tool call: both counters of this version start at
// zero, the baseline Prometheus takes the step's own sample from (a one-shot
// process has no other sample of its own).
export function startHeadTrackSpeed(meter: Meter, version: number): void {
  const { video, work } = countersOf(meter);
  video.add(0, versionAttributes(version));
  work.add(0, versionAttributes(version));
}

// After a successful step.
export function recordHeadTrackSpeed(
  meter: Meter,
  version: number,
  videoSeconds: number,
  workSeconds: number,
): void {
  const { video, work } = countersOf(meter);
  video.add(videoSeconds, versionAttributes(version));
  work.add(workSeconds, versionAttributes(version));
}
