import {
  type Edit,
  ISSEBYA_PRESET,
  type Transcript,
  resolveTimeline,
  wordsText,
} from "@edit-issebya/edit";
import type { FramesLayout } from "./preview-sources";

// The read-only tracks timeline's rows, in display order. A legacy `cutout`
// track is never shown. A future title kind adds one entry here.
export const TRACK_ROWS = [
  { key: "footage", label: "Footage" },
  { key: "behind", label: "Behind" },
  { key: "captions", label: "Captions" },
  { key: "overlays", label: "Accents" },
  { key: "transitions", label: "Transitions" },
  { key: "sounds", label: "Sounds" },
] as const;

export type TrackKey = (typeof TRACK_ROWS)[number]["key"];

export interface TimelineItem {
  id: string;
  start: number;
  end: number;
  label: string;
}

export interface TimelineRow {
  key: TrackKey;
  label: string;
  items: TimelineItem[];
}

export interface Timeline {
  duration: number;
  rows: TimelineRow[];
}

// `mm:ss`, floored, never negative: 52.4 is `00:52`.
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

// The shown version's items on the reel's clock, every row present even when
// empty. The spans are resolveTimeline's (the one the builder uses), so the
// rows sit where the preview plays them.
export function timelineRows(edit: Edit, transcript: Transcript): Timeline {
  const spans = resolveTimeline(edit, transcript);
  const words = (ids: readonly string[] | undefined) =>
    ids && ids.length > 0 ? wordsText(ids, transcript, ISSEBYA_PRESET) : "";
  const item = (id: string, label: (start: number, end: number) => string): TimelineItem => {
    const span = spans.get(id);
    if (!span) throw new Error(`timeline: no span for ${id}`);
    return { id, start: span.start, end: span.end, label: label(span.start, span.end) };
  };
  const { tracks } = edit;
  const items: Record<TrackKey, TimelineItem[]> = {
    footage: tracks.footage.map((clip) => item(clip.id, (start, end) => formatClock(end - start))),
    // A photo by its spot, a big word by itself.
    behind: (tracks.behind ?? []).map((entry) =>
      item(entry.id, () => (entry.kind === "photo" ? `photo ${entry.spot}` : entry.text)),
    ),
    captions: tracks.captions.map((caption) =>
      item(caption.id, () => caption.text ?? words(caption.words)),
    ),
    overlays: tracks.overlays.map((overlay) =>
      item(overlay.id, () => overlay.text ?? words(overlay.words)),
    ),
    transitions: tracks.transitions.map((transition) => item(transition.id, () => transition.type)),
    sounds: tracks.sounds.map((sound) => item(sound.id, () => sound.sound)),
  };
  return {
    duration: edit.duration,
    rows: TRACK_ROWS.map(({ key, label }) => ({ key, label, items: items[key] })),
  };
}

export interface RulerTick {
  seconds: number;
  label: string | null;
}

// A tick at every whole second up to the reel's end, labelled every 5 s
// (every 10 s on a reel longer than a minute).
export function rulerTicks(duration: number): RulerTick[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const every = duration > 60 ? 10 : 5;
  const ticks: RulerTick[] = [];
  for (let seconds = 0; seconds <= Math.floor(duration); seconds += 1) {
    ticks.push({ seconds, label: seconds % every === 0 ? formatClock(seconds) : null });
  }
  return ticks;
}

// The sprite frame shown at a footage time: one frame every `everySeconds`,
// clamped to the sprite (a longer reel repeats its last frame). A clip plays
// its file from 0, so a clip's footage time is reel time minus its start.
export function frameIndexAt(footageSeconds: number, layout: FramesLayout): number {
  const index = Number.isFinite(footageSeconds)
    ? Math.floor(footageSeconds / layout.everySeconds)
    : 0;
  return Math.min(Math.max(index, 0), layout.columns - 1);
}
