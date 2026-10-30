"use client";

import { capture } from "@/lib/track";
import { useEffect, useRef, useState } from "react";
import { reelVariant, type Reel } from "@/content/reels";
import { newThresholds, playedFraction, type ProgressPercent } from "@/lib/reel-progress";

/**
 * One reel in the slider: the 9:16 video and its small uppercase label (from
 * the issebya.homes shop card, apps/website/src/app/(main)/shop/ui/ProductCard.tsx)
 * on the page's white, with no card colour. The reel's title names the card
 * for screen readers only.
 *
 * The card is a size container. Inside it, one column holds the video and the
 * fixed-height label row (`--reel-label`, set with the track in globals.css);
 * the column takes the largest width at which both fit the card, so every
 * card's video is the same size. A card wider than it is tall (one slot on a
 * phone) centres the video (see `.reel-column` in globals.css).
 */
export function ReelCard({ reel }: { reel: Reel }) {
  const titleId = `reel-${reel.id}-title`;

  return (
    <article
      aria-labelledby={titleId}
      className="relative h-full text-foreground [container-type:size]"
    >
      <h3 id={titleId} className="sr-only">
        {reel.title}
      </h3>
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
          <p
            data-testid="reel-label"
            className="h-(--reel-label) pt-3 text-center text-[10px] tracking-[0.2em] uppercase short:pt-2"
          >
            {reel.label}
          </p>
        </div>
      </div>
    </article>
  );
}

// The event a playing reel sends so the others stop: only one reel is heard
// at a time.
const PLAY_EVENT = "reel-play";

// Seconds: a play that starts this close to 0 counts as from the start.
const START_TOLERANCE = 0.5;

// Inline and paused until clicked, with sound; never autoplays. Playing one
// reel pauses any other.
function ReelVideo({ reel, src }: { reel: Reel; src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // reel_progress bookkeeping, refs only (no render): the thresholds sent in
  // this play-through and the last time seen, to spot the loop wrapping.
  const progressSentRef = useRef(new Set<ProgressPercent>());
  const lastTimeRef = useRef(0);
  const variant = reelVariant(reel.id);

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
          capture("reel_played", { reel_id: reel.id, variant });
        })
        .catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  // Full screen with sound. iOS Safari only offers it on the video element
  // itself (webkitEnterFullscreen); everywhere else the standard API.
  function openFullscreen() {
    const video = videoRef.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!video) return;
    document.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: reel.id }));
    if (typeof video.requestFullscreen === "function") {
      video.requestFullscreen().catch(() => undefined);
    } else {
      video.webkitEnterFullscreen?.();
    }
    video.play().catch(() => undefined);
    capture("reel_fullscreen", { reel_id: reel.id, variant });
  }

  // A play from the start (the first play, or after the time was reset)
  // begins a new play-through, so every threshold can be sent again.
  function onPlay() {
    setPlaying(true);
    const video = videoRef.current;
    if (video && video.currentTime < START_TOLERANCE) {
      progressSentRef.current.clear();
      lastTimeRef.current = 0;
    }
  }

  // Cheap on every timeupdate: nothing to do once all three are sent.
  function trackProgress(fraction: number) {
    const sent = progressSentRef.current;
    if (sent.size === 3) return;
    for (const percent of newThresholds(fraction, sent)) {
      sent.add(percent);
      capture("reel_progress", { reel_id: reel.id, variant, percent });
    }
  }

  function onTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    const now = video.currentTime;
    trackProgress(playedFraction(lastTimeRef.current, now, video.duration));
    lastTimeRef.current = now;
  }

  return (
    <div className="relative h-full w-full">
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
          onPlay={onPlay}
          onTimeUpdate={onTimeUpdate}
          onEnded={() => trackProgress(1)}
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
      <button
        type="button"
        aria-label={`Full screen ${reel.title}`}
        onClick={openFullscreen}
        className="reel-fullscreen absolute top-2 right-2 flex size-9 items-center justify-center rounded-md bg-white/90 text-neutral-900"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>
    </div>
  );
}
