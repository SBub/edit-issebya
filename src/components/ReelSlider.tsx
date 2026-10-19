"use client";

import posthog from "posthog-js";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
 * width (a container query): one per view on phones, centred, with the cards
 * either side peeking in so the swipe is discoverable, up to four on wide
 * screens.
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
  // Which card is in view, and whether the track overflows at all (on wide
  // screens every reel fits, so the dots are not shown).
  const [active, setActive] = useState(0);
  const [overflows, setOverflows] = useState(false);

  // The track's scroll position and size are an external system: a scroll
  // listener and a ResizeObserver keep the dots in step with them.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const update = () => {
      setOverflows(track.scrollWidth > track.clientWidth + END_TOLERANCE);
      const step = slotStep(track);
      setActive(step > 0 ? Math.round(track.scrollLeft / step) : 0);
    };
    update();
    track.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(track);
    return () => {
      track.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  function goTo(index: number) {
    const track = trackRef.current;
    if (!track) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    keyboardScroll.current = true;
    track.scrollTo({ left: index * slotStep(track), behavior: reduce ? "auto" : "smooth" });
    posthog.capture("reel_slider_navigated", {
      direction: index > active ? "next" : "prev",
      method: "dot",
    });
  }

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
    const step = slotStep(track);
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
      <p className="text-xs text-neutral-600 short:text-[11px]">{LANDING.variations}</p>
      <ul
        ref={trackRef}
        tabIndex={0}
        aria-label="Reels"
        className="reel-track flex min-h-0 px-[7.5%] scroll-px-[7.5%] @min-[28rem]:px-0 @min-[28rem]:scroll-px-0 flex-[0_1_auto] snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 [&::-webkit-scrollbar]:hidden"
      >
        {reels.map((reel) => (
          <li
            key={reel.id}
            className="h-full shrink-0 basis-full snap-center @min-[28rem]:snap-start @min-[28rem]:basis-[calc((100%-0.75rem)/2)] @min-[44rem]:basis-[calc((100%-1.5rem)/3)] @min-[60rem]:basis-[calc((100%-2.25rem)/4)]"
          >
            <ReelCard reel={reel} />
          </li>
        ))}
      </ul>
      {overflows ? (
        <div className="flex justify-center gap-2 pt-1" role="group" aria-label="Choose a reel">
          {reels.map((reel, index) => (
            <button
              key={reel.id}
              type="button"
              aria-label={`Show ${reel.title}`}
              aria-current={index === active ? "true" : undefined}
              onClick={() => goTo(index)}
              className="flex size-6 items-center justify-center"
            >
              <span
                aria-hidden="true"
                className={`block h-2 rounded-full transition-[width] ${index === active ? "w-5 bg-neutral-900" : "w-2 bg-neutral-300"}`}
              />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// One card's width plus the gap: the distance between two snap points.
function slotStep(track: HTMLElement): number {
  const slot = track.firstElementChild as HTMLElement | null;
  const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
  return (slot?.offsetWidth ?? track.clientWidth) + gap;
}
