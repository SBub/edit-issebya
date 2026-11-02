// The media readiness the preview's clock waits for, as plain data the
// component reads from the composition's videos.

// HTMLMediaElement.HAVE_FUTURE_DATA: it can play on from the current point.
export const HAVE_FUTURE_DATA = 3;

export interface MediaState {
  start: number;
  duration: number;
  readyState: number;
  seeking: boolean;
  // The element's own currentTime, when known: right after a seek a video can
  // still report data for where it was, so it must be at the target too.
  position?: number;
}

// How far a video may sit from the target and count as there (a frame or two
// of the preview copies' 30 fps, plus the runtime's own sync slack).
const POSITION_TOLERANCE = 0.1;

// The media whose [start, start + duration) window contains t.
export function activeAt<T extends MediaState>(media: readonly T[], t: number): T[] {
  return media.filter((item) => t >= item.start && t < item.start + item.duration);
}

// Whether every medium playing at t can play from there. A reel with clips
// but none active at t (a gap, or the very end) can play: nothing to wait on.
export function canPlayFrom(media: readonly MediaState[], t: number): boolean {
  return activeAt(media, t).every(
    (item) =>
      !item.seeking &&
      item.readyState >= HAVE_FUTURE_DATA &&
      (item.position === undefined ||
        Math.abs(item.position - (t - item.start)) <= POSITION_TOLERANCE),
  );
}
