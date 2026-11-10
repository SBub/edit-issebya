import {
  type Edit,
  ISSEBYA_PRESET,
  type Transcript,
  resolveTimeline,
  wordsText,
} from "@edit-issebya/edit";
import type { FramesLayout } from "./preview-sources";

// The read-only tracks timeline's rows, in display order. The captions and
// sounds tracks are never shown (the edit still carries them). The hook is an overlay with its own row (`hook`), so the
// Accents row keeps only spoken accents. A future title kind adds one entry
// here.
export const TRACK_ROWS = [
  { key: "footage", label: "Footage" },
  { key: "behind", label: "Behind" },
  { key: "hook", label: "Hook" },
  { key: "overlays", label: "Accents" },
  { key: "transitions", label: "Transitions" },
] as const;

export type TrackKey = (typeof TRACK_ROWS)[number]["key"];

const ITEM_COLOURS: Record<TrackKey, string> = {
  footage: "bg-track-footage",
  behind: "bg-track-behind text-surface",
  hook: "bg-track-hook text-surface",
  overlays: "bg-track-accents",
  transitions: "bg-track-transitions",
};

// A row item's colour and shape. Behind, Hook, Accents and Transitions items are
// slightly rounded (rounded-track, 4px, the studio's one exception to its
// single corner radius); a footage clip holds a strip of frames and stays
// square.
export function trackItemClass(key: TrackKey): string {
  return key === "footage" ? ITEM_COLOURS[key] : `${ITEM_COLOURS[key]} rounded-track`;
}

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

// Temporary testing aid, remove later: while true the player's clock, the
// ruler's read-out and each track item's tooltip show milliseconds, so caption
// sync can be judged by eye. Set it to false (or delete it with clockText and
// itemTitle's ms branch) to go back to whole seconds.
const SHOW_MILLISECONDS = true;

// `mm:ss.mmm`, rounded to the millisecond, never negative: 3.4124 is `00:03.412`.
export function formatClockMs(seconds: number): string {
  const ms = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
  const whole = Math.floor(ms / 1000);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(minutes, 2)}:${pad(rest, 2)}.${pad(ms - whole * 1000, 3)}`;
}

// The time the player's clock and the ruler's read-out show.
export function clockText(seconds: number): string {
  return SHOW_MILLISECONDS ? formatClockMs(seconds) : formatClock(seconds);
}

// A track item's native tooltip: its label and exact span, `There (0.412 to
// 0.733 s)` or `visual right (1.000 to 3.000 s)` (two decimals without the
// testing aid).
export function itemTitle(item: TimelineItem): string {
  const digits = SHOW_MILLISECONDS ? 3 : 2;
  return `${item.label} (${item.start.toFixed(digits)} to ${item.end.toFixed(digits)} s)`;
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
    // A visual, always in front of the speaker; a big word by its text.
    behind: (tracks.behind ?? []).map((entry) =>
      item(entry.id, () => (entry.kind === "word" ? entry.text : "visual, in front")),
    ),
    // The written hook by its text.
    hook: tracks.overlays
      .filter((overlay) => overlay.kind === "hook")
      .map((overlay) => item(overlay.id, () => overlay.text ?? "")),
    overlays: tracks.overlays
      .filter((overlay) => overlay.kind !== "hook")
      .map((overlay) => item(overlay.id, () => overlay.text ?? words(overlay.words))),
    transitions: tracks.transitions.map((transition) => item(transition.id, () => transition.type)),
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

// The ruler is the one scrubber: what an arrow key moves, in seconds, and
// with Shift held.
const SCRUB_STEP = 1;
const SCRUB_STEP_LARGE = 5;

function clampTo(seconds: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(Math.max(seconds, 0), duration);
}

// The reel time under a pointer on the ruler: its x within the ruler's own
// box (never the window), clamped to 0 and the duration.
export function secondsAtX(
  clientX: number,
  box: { left: number; width: number },
  duration: number,
): number {
  if (!(box.width > 0)) return 0;
  return clampTo(((clientX - box.left) / box.width) * duration, duration);
}

// Where a key on the ruler moves the position, or null for a key it ignores:
// arrows step SCRUB_STEP (SCRUB_STEP_LARGE with Shift), Page Up and Page Down
// step SCRUB_STEP_LARGE, Home and End jump to the start and the end.
export function scrubKey(
  key: string,
  shift: boolean,
  position: number,
  duration: number,
): number | null {
  const step = shift ? SCRUB_STEP_LARGE : SCRUB_STEP;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clampTo(position + step, duration);
    case "ArrowLeft":
    case "ArrowDown":
      return clampTo(position - step, duration);
    case "PageUp":
      return clampTo(position + SCRUB_STEP_LARGE, duration);
    case "PageDown":
      return clampTo(position - SCRUB_STEP_LARGE, duration);
    case "Home":
      return 0;
    case "End":
      return clampTo(duration, duration);
    default:
      return null;
  }
}
