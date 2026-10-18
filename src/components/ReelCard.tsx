"use client";

import posthog from "posthog-js";
import { useRef, useState } from "react";
import type { Reel } from "@/content/reels";

/**
 * One reel in the slider, styled after the issebya.homes shop card
 * (apps/website/src/app/(main)/shop/ui/ProductCard.tsx): the cream box, the
 * p-3.5 padding and the label, title-and-duration and caption block. Unlike
 * the shop card the media is 9:16, the title is underlined at rest, and the
 * caption clamps to two lines.
 *
 * The media area is a size container and the only part of the card that
 * flexes: the 9:16 box inside takes the largest size that fits it, so the card
 * never overflows its slot at any slot width or height.
 */
const REEL_CARD_BOX_CLASS = "flex flex-col h-full bg-reel-card p-3.5 short:p-2.5";

export function ReelCard({ reel }: { reel: Reel }) {
  const titleId = `reel-${reel.id}-title`;

  return (
    <article aria-labelledby={titleId} className={`${REEL_CARD_BOX_CLASS} text-foreground`}>
      <div data-testid="reel-media" className="relative min-h-0 flex-1 [container-type:size]">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative aspect-[9/16] w-[min(100cqw,calc(100cqh*9/16))] overflow-hidden">
            {reel.videoSrc ? (
              <ReelVideo reel={reel} src={reel.videoSrc} />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-neutral-200 p-2 text-center text-xs text-neutral-600">
                Reel coming soon
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 pt-3 text-xs short:gap-1 short:pt-2">
        <p data-testid="reel-label" className="text-center text-[10px] tracking-[0.2em] uppercase">
          {reel.label}
        </p>
        <div className="flex justify-between gap-2 text-sm font-medium short:text-xs">
          <h3
            id={titleId}
            data-testid="reel-title"
            className="truncate underline underline-offset-4"
          >
            {reel.title}
          </h3>
          <span className="shrink-0">{reel.duration}</span>
        </div>
        <p data-testid="reel-caption" className="line-clamp-2 leading-relaxed short:leading-snug">
          {reel.caption}
        </p>
      </div>
    </article>
  );
}

// Muted, inline and paused until clicked; never autoplays and has no unmute
// control. React does not reliably reflect `muted` as an attribute, so the ref
// sets the property too.
function ReelVideo({ reel, src }: { reel: Reel; src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);

  function toggle() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video
        .play()
        .then(() => {
          setPlaying(true);
          posthog.capture("reel_played", { reel_id: reel.id });
        })
        .catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  return (
    <button
      type="button"
      aria-label={`${playing ? "Pause" : "Play"} ${reel.title}`}
      onClick={toggle}
      className="relative block h-full w-full"
    >
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el) el.muted = true;
        }}
        src={src}
        poster={reel.poster ?? undefined}
        muted
        playsInline
        loop
        preload="metadata"
        onPause={() => setPlaying(false)}
        className="h-full w-full object-cover"
      />
      {playing ? null : (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center bg-black/10"
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-white/90 text-neutral-900">
            <svg viewBox="0 0 24 24" className="ml-0.5 size-4" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </span>
      )}
    </button>
  );
}
