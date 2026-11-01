// HTMLMediaElement.HAVE_FUTURE_DATA, as a literal so Node tests need no DOM.
const HAVE_FUTURE_DATA = 3;
// How far an element's own time may be from the time the clock holds at.
const AT_TOLERANCE_SECONDS = 0.25;

// The part of a media element the readiness rule reads.
export interface MediaLike extends EventTarget {
  readonly readyState: number;
  readonly seeking: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly buffered: {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
  };
}

// Can play forward from its current point now: not seeking, and data for the
// current frame and at least the next one. With `at`, the element must also
// stand at that time (a seek the player has asked for but the element has not
// started yet does not count as ready).
export function canPlayFrom(el: MediaLike, at?: number): boolean {
  if (el.seeking || el.readyState < HAVE_FUTURE_DATA) return false;
  return at === undefined || Math.abs(el.currentTime - at) <= AT_TOLERANCE_SECONDS;
}

// How much buffered data past its current point lets an element play on.
const LOOKAHEAD_SECONDS = 0.5;

// Has stopped being able to play on while the clock runs: it reports too
// little data (or is seeking) and its buffer does not reach LOOKAHEAD_SECONDS
// past its current point (or its end). With the data buffered the dip is the
// decoder catching up or the player's own drift-correcting seek; both pass at
// once, so they are not a stall.
export function isStalled(el: MediaLike): boolean {
  if (!el.seeking && el.readyState >= HAVE_FUTURE_DATA) return false;
  const until = Math.min(el.currentTime + LOOKAHEAD_SECONDS, el.duration);
  for (let i = 0; i < el.buffered.length; i++) {
    if (el.buffered.start(i) <= el.currentTime && el.buffered.end(i) >= until) return false;
  }
  return true;
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
