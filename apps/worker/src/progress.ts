// The progress throttle of one step: the first value is written at once, then
// at most one value per window (a value arriving inside the window is dropped,
// the next line after it carries a fresher one), never a value lower than or
// equal to the last written. `finish()` writes 100 once the queued writes are
// through; after `stop()` nothing more is written. Writes run one after the
// other on one promise chain, and a failed write is reported and never stops
// the next one.
export const PROGRESS_EVERY_MS = 10_000;

export interface ProgressThrottle {
  push(percent: number): void;
  finish(): Promise<void>;
  stop(): void;
  // Resolves once every queued write has ended.
  settled(): Promise<void>;
}

export function createProgressThrottle({
  everyMs = PROGRESS_EVERY_MS,
  now = Date.now,
  write,
  onError,
}: {
  everyMs?: number;
  now?: () => number;
  write: (percent: number) => Promise<void>;
  onError: (error: unknown) => void;
}): ProgressThrottle {
  let chain: Promise<void> = Promise.resolve();
  let last: number | null = null;
  let lastWriteAt = 0;
  let stopped = false;

  // The final 100 is queued as the throttle stops, so it skips the check.
  const enqueue = (percent: number, final = false) => {
    chain = chain.then(async () => {
      if (stopped && !final) return;
      try {
        await write(percent);
      } catch (error) {
        onError(error);
      }
    });
  };

  return {
    push(percent) {
      if (stopped) return;
      if (last !== null && percent <= last) return;
      const at = now();
      if (last !== null && at - lastWriteAt < everyMs) return;
      last = percent;
      lastWriteAt = at;
      enqueue(percent);
    },
    async finish() {
      await chain;
      if (stopped) return;
      last = 100;
      stopped = true;
      enqueue(100, true);
      await chain;
    },
    stop() {
      stopped = true;
    },
    settled() {
      return chain;
    },
  };
}
