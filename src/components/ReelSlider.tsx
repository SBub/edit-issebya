"use client";

import posthog from "posthog-js";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Reel } from "@/content/reels";
import { ReelCard } from "./ReelCard";

type Direction = "prev" | "next";
type Method = "button" | "keyboard";

// Scroll ends within this many pixels count as reached.
const END_TOLERANCE = 1;

/**
 * A scroll-snap track of reel cards with previous/next buttons and arrow keys.
 * No autoplay. The track scrolls inside the slider box, so it never widens the
 * page. Card slots follow the slider's own width (a container query): one per
 * view on phones, up to four on wide screens.
 */
export function ReelSlider({ reels }: { reels: readonly Reel[] }) {
  const trackRef = useRef<HTMLUListElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(reels.length <= 1);

  // The track's scroll position and size are an external system: a scroll
  // listener and a ResizeObserver keep the end states in step with them.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const update = () => {
      setAtStart(track.scrollLeft <= END_TOLERANCE);
      setAtEnd(track.scrollLeft + track.clientWidth >= track.scrollWidth - END_TOLERANCE);
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

  function move(direction: Direction, method: Method) {
    const track = trackRef.current;
    if (!track) return;
    const start = track.scrollLeft <= END_TOLERANCE;
    const end = track.scrollLeft + track.clientWidth >= track.scrollWidth - END_TOLERANCE;
    if ((direction === "prev" && start) || (direction === "next" && end)) return;
    const slot = track.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const step = (slot?.offsetWidth ?? track.clientWidth) + gap;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // scrollBy on the track only: scrollIntoView could scroll the page.
    track.scrollBy({
      left: direction === "next" ? step : -step,
      behavior: reduce ? "auto" : "smooth",
    });
    posthog.capture("reel_slider_navigated", { direction, method });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move("prev", "keyboard");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      move("next", "keyboard");
    }
  }

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Edited reels"
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col gap-2 [container-type:inline-size] short:gap-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium short:text-xs">Edited reels</h2>
        <div className="flex gap-1.5">
          <SliderButton
            label="Previous reel"
            disabled={atStart}
            onClick={() => move("prev", "button")}
          >
            <path d="M15 6l-6 6 6 6" />
          </SliderButton>
          <SliderButton label="Next reel" disabled={atEnd} onClick={() => move("next", "button")}>
            <path d="M9 6l6 6-6 6" />
          </SliderButton>
        </div>
      </div>
      <ul
        ref={trackRef}
        tabIndex={0}
        aria-label="Reels"
        className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 [&::-webkit-scrollbar]:hidden"
      >
        {reels.map((reel) => (
          <li
            key={reel.id}
            className="h-full shrink-0 basis-full snap-start @min-[28rem]:basis-[calc((100%-0.75rem)/2)] @min-[44rem]:basis-[calc((100%-1.5rem)/3)] @min-[60rem]:basis-[calc((100%-2.25rem)/4)]"
          >
            <ReelCard reel={reel} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SliderButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center border border-neutral-300 bg-white text-neutral-900 hover:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 short:size-7"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}
