"use client";

import { useEffect, useRef, useState } from "react";
import type { FramesLayout } from "@/lib/preview-sources";
import {
  type Timeline,
  type TimelineItem,
  type TrackKey,
  frameIndexAt,
  rulerTicks,
} from "@/lib/tracks-timeline";

export interface TimelineFrames {
  url: string;
  layout: FramesLayout;
}

interface Props {
  timeline: Timeline;
  // The player's clock, in seconds.
  position: number;
  // The footage preview copy's frames sprite; null shows a plain bar.
  frames: TimelineFrames | null;
}

const FOOTAGE_ROW_PX = 36;
const ROW_PX = 20;
const TILE_PX = (FOOTAGE_ROW_PX * 9) / 16;

const ITEM_COLOURS: Record<TrackKey, string> = {
  footage: "bg-track-footage",
  behind: "bg-track-behind text-surface",
  captions: "bg-track-captions",
  overlays: "bg-track-accents",
  transitions: "bg-track-transitions",
  sounds: "bg-track-sounds text-surface",
};

function percent(seconds: number, duration: number): number {
  return duration > 0 ? Math.min(Math.max((seconds / duration) * 100, 0), 100) : 0;
}

function span(item: TimelineItem): string {
  return `${item.label} (${item.start.toFixed(2)} to ${item.end.toFixed(2)} s)`;
}

// A footage clip as a strip of frames from the sprite: as many tiles as fit
// the clip's own width (read from its box, never the window), each showing the
// frame at its centre's footage time (reel time minus the clip's start).
function FootageFrames({ item, frames }: { item: TimelineItem; frames: TimelineFrames }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const count = width > 0 ? Math.ceil(width / TILE_PX) : 0;
  const length = item.end - item.start;
  const { layout } = frames;
  return (
    <div ref={ref} className="absolute inset-0 flex overflow-hidden">
      {Array.from({ length: count }, (_, tile) => {
        const centre = width > 0 ? (((tile + 0.5) * TILE_PX) / width) * length : 0;
        const index = frameIndexAt(centre, layout);
        return (
          <div
            key={tile}
            data-frame-index={index}
            className="h-full flex-none"
            style={{
              width: TILE_PX,
              backgroundImage: `url("${frames.url}")`,
              backgroundSize: `${layout.columns * TILE_PX}px ${FOOTAGE_ROW_PX}px`,
              backgroundPosition: `${-index * TILE_PX}px 0`,
            }}
          />
        );
      })}
    </div>
  );
}

// The shown version's tracks on the reel's clock, read only: a ruler, one row
// per track with its items where resolveTimeline puts them, and a playhead
// following the player. Nothing in it takes focus, a pointer or a drag.
export function TracksTimeline({ timeline, position, frames }: Props) {
  const { duration, rows } = timeline;
  const ticks = rulerTicks(duration);
  const at = Math.min(Math.max(position, 0), duration);

  return (
    <section
      aria-label="Tracks"
      data-testid="tracks"
      className="relative flex flex-none flex-col gap-0.5 text-[10px] leading-none select-none"
    >
      <div className="flex h-4 items-end">
        <span className="w-20 flex-none" />
        <div className="relative h-full min-w-0 flex-1" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.seconds}
              className={`absolute bottom-0 w-px bg-line ${tick.label ? "h-2" : "h-1"}`}
              style={{ left: `${percent(tick.seconds, duration)}%` }}
            >
              {tick.label && (
                <span className="absolute bottom-2.5 left-0.5 whitespace-nowrap text-muted tabular-nums">
                  {tick.label}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          data-track={row.key}
          className="flex items-center"
          style={{ height: row.key === "footage" ? FOOTAGE_ROW_PX : ROW_PX }}
        >
          <span className="w-20 flex-none truncate pr-2 text-xs text-muted">{row.label}</span>
          <div
            data-testid="track-lane"
            className="relative h-full min-w-0 flex-1 overflow-hidden rounded-sm bg-panel"
          >
            {row.items.map((item) => (
              <div
                key={item.id}
                data-testid="track-item"
                data-item-id={item.id}
                data-start={item.start.toFixed(3)}
                data-end={item.end.toFixed(3)}
                title={span(item)}
                className={`absolute inset-y-0 overflow-hidden rounded-sm ${ITEM_COLOURS[row.key]}`}
                style={{
                  left: `${percent(item.start, duration)}%`,
                  width: `${percent(item.end - item.start, duration)}%`,
                  minWidth: 2,
                }}
              >
                {row.key === "footage" && frames && <FootageFrames item={item} frames={frames} />}
                <span
                  className={`relative block truncate px-1 leading-5 ${
                    row.key === "footage" ? "bg-surface/60 text-ink" : ""
                  }`}
                >
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="pointer-events-none absolute inset-y-0 right-0 left-20 overflow-hidden">
        <div
          data-testid="playhead"
          data-seconds={at.toFixed(3)}
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-full"
          style={{ transform: `translateX(${percent(at, duration)}%)` }}
        >
          <span className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-accent" />
        </div>
      </div>
    </section>
  );
}
