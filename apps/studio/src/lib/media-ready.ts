// HTMLMediaElement.HAVE_FUTURE_DATA, as a literal so Node tests need no DOM.
const HAVE_FUTURE_DATA = 3;
// How far an element's own time may be from the time the clock holds at.
const AT_TOLERANCE_SECONDS = 0.25;

// The part of a media element the readiness rule reads.
export interface MediaLike extends EventTarget {
  readonly readyState: number;
  readonly seeking: boolean;
  readonly currentTime: number;
}

// Can play forward from its current point now: not seeking, and data for the
// current frame and at least the next one. With `at`, the element must also
// stand at that time (a seek the player has asked for but the element has not
// started yet does not count as ready).
export function canPlayFrom(el: MediaLike, at?: number): boolean {
  if (el.seeking || el.readyState < HAVE_FUTURE_DATA) return false;
  return at === undefined || Math.abs(el.currentTime - at) <= AT_TOLERANCE_SECONDS;
}

const EVENTS = ["canplay", "canplaythrough", "seeked", "loadeddata", "playing", "timeupdate"];

// Resolves once every element can play from its current point (or from `at`),
// re-checking on each readiness event; rejects with an AbortError when the
// signal aborts. Every listener is removed either way.
export function whenReady(elements: MediaLike[], signal: AbortSignal, at?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const cleanup = () => {
      for (const el of elements) for (const name of EVENTS) el.removeEventListener(name, check);
      signal.removeEventListener("abort", abort);
    };
    function check() {
      if (!elements.every((el) => canPlayFrom(el, at))) return;
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    }
    for (const el of elements) for (const name of EVENTS) el.addEventListener(name, check);
    signal.addEventListener("abort", abort);
    check();
  });
}
