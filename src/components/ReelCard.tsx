"use client";

import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import type { Reel } from "@/content/reels";

/**
 * One reel in the slider, laid out after the issebya.homes shop card
 * (apps/website/src/app/(main)/shop/ui/ProductCard.tsx): the label,
 * title-and-duration and caption block under the media, on the page's white
 * with no card colour. Unlike the shop card the media is 9:16, the title is
 * underlined at rest, and the caption clamps to two lines.
 *
 * The card is a size container. Inside it, one column holds the 9:16 video
 * and the text block under it; the column takes the largest width at which
 * the video plus the fixed-height text block (`--reel-caption`, set with the
 * track in globals.css) fit the card, so the text is always as wide as its
 * video and every card's video is the same size, whatever its caption. A
 * card wider than it is tall (one slot on a phone) keeps the full width for
 * the text and centres the video above it (see `.reel-column` in globals.css).
 */
export function ReelCard({ reel }: { reel: Reel }) {
  const titleId = `reel-${reel.id}-title`;

  return (
    <article
      aria-labelledby={titleId}
      className="relative h-full text-foreground [container-type:size]"
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="reel-column flex flex-col">
          <div
            data-testid="reel-media"
            className="reel-video relative aspect-[9/16] overflow-hidden"
          >
            {reel.videoSrc ? (
              <ReelVideo reel={reel} src={reel.videoSrc} />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-neutral-200 p-2 text-center text-xs text-neutral-600">
                Reel coming soon
              </div>
            )}
          </div>

          <div className="flex h-(--reel-caption) flex-col gap-1.5 overflow-hidden pt-3 text-xs short:gap-1 short:pt-2">
            <p
              data-testid="reel-label"
              className="text-center text-[10px] tracking-[0.2em] uppercase"
            >
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
            <p
              data-testid="reel-caption"
              className="line-clamp-2 leading-relaxed short:leading-snug"
            >
              {reel.caption}
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

// The event a playing reel sends so the others stop: only one reel is heard
// at a time.
const PLAY_EVENT = "reel-play";

// Inline and paused until clicked, with sound; never autoplays. Playing one
// reel pauses any other.
function ReelVideo({ reel, src }: { reel: Reel; src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Another reel starting is an external event this one follows.
  useEffect(() => {
    const onOtherPlay = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== reel.id) videoRef.current?.pause();
    };
    document.addEventListener(PLAY_EVENT, onOtherPlay);
    return () => document.removeEventListener(PLAY_EVENT, onOtherPlay);
  }, [reel.id]);

  function toggle() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      document.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: reel.id }));
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
        ref={videoRef}
        src={src}
        poster={reel.poster ?? undefined}
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
