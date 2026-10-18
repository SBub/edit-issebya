"use client";

import posthog from "posthog-js";
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { Reel } from "@/content/reels";
import { LANDING } from "@/content/landing";
import { ReelCard } from "./ReelCard";

type Direction = "prev" | "next";

// Scroll ends within this many pixels count as reached.
const END_TOLERANCE = 1;

/**
 * A scroll-snap track of reel cards, moved by swiping (or scrolling) and by
 * the arrow keys. No buttons and no autoplay. The track scrolls inside the
 * slider box, so it never widens the page. Card slots follow the slider's own
 * width (a container query): one per view on phones, with the next card
 * peeking in so the swipe is discoverable, up to four on wide screens.
 *
 * The track is only as tall as a card needs (see `.reel-track` in
 * globals.css) and the block is centred, so when the slots are narrow the
 * spare height goes above and below the whole slider, not between a video
 * and its label.
 */
export function ReelSlider({ reels }: { reels: readonly Reel[] }) {
  const trackRef = useRef<HTMLUListElement | null>(null);
  // Set while an arrow key's scroll runs, so its scrollend is not counted again
  // as a swipe.
  const keyboardScroll = useRef(false);

  // A swipe or scroll that settles on a new position is the slider
  // interaction PostHog counts; the browser's scrollend is the external event.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let last = track.scrollLeft;
    const onScrollEnd = () => {
      const now = track.scrollLeft;
      if (Math.abs(now - last) <= END_TOLERANCE) return;
      const direction: Direction = now > last ? "next" : "prev";
      last = now;
      if (keyboardScroll.current) {
        keyboardScroll.current = false;
        return;
      }
      posthog.capture("reel_slider_navigated", { direction, method: "swipe" });
    };
    track.addEventListener("scrollend", onScrollEnd);
    return () => track.removeEventListener("scrollend", onScrollEnd);
  }, []);

  function move(direction: Direction) {
    const track = trackRef.current;
    if (!track) return;
    const start = track.scrollLeft <= END_TOLERANCE;
    const end = track.scrollLeft + track.clientWidth >= track.scrollWidth - END_TOLERANCE;
    if ((direction === "prev" && start) || (direction === "next" && end)) return;
    const slot = track.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const step = (slot?.offsetWidth ?? track.clientWidth) + gap;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    keyboardScroll.current = true;
    // scrollBy on the track only: scrollIntoView could scroll the page.
    track.scrollBy({
      left: direction === "next" ? step : -step,
      behavior: reduce ? "auto" : "smooth",
    });
    posthog.capture("reel_slider_navigated", { direction, method: "keyboard" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move("prev");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      move("next");
    }
  }

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Edited reels"
      onKeyDown={onKeyDown}
      className="reel-slider flex h-full min-h-0 flex-col justify-center gap-2 [container-type:inline-size] short:gap-1.5"
    >
      <h2 className="text-sm font-medium short:text-xs">Edited reels</h2>
      <ul
        ref={trackRef}
        tabIndex={0}
        aria-label="Reels"
        className="reel-track flex min-h-0 flex-[0_1_auto] snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 [&::-webkit-scrollbar]:hidden"
      >
        {reels.map((reel) => (
          <li
            key={reel.id}
            className="h-full shrink-0 basis-[85%] snap-start @min-[28rem]:basis-[calc((100%-0.75rem)/2)] @min-[44rem]:basis-[calc((100%-1.5rem)/3)] @min-[60rem]:basis-[calc((100%-2.25rem)/4)]"
          >
            <ReelCard reel={reel} />
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-600 short:text-[11px]">{LANDING.variations}</p>
    </section>
  );
}
