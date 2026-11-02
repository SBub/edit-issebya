// The long-running worker's heartbeat: one beat at start, then one every five
// minutes, so the studio can tell since when the worker is offline (no beat
// for eleven minutes). A failed beat is reported and the next one still
// comes. Only `main.ts` beats; `once` never does.
export const HEARTBEAT_EVERY_MS = 5 * 60_000;

export function startHeartbeat({
  beat,
  everyMs = HEARTBEAT_EVERY_MS,
  onError = (error: unknown) => console.error("worker: heartbeat failed:", error),
}: {
  beat: () => Promise<void>;
  everyMs?: number;
  onError?: (error: unknown) => void;
}): { stop(): void } {
  const once = () => {
    beat().catch(onError);
  };
  once();
  const timer = setInterval(once, everyMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
