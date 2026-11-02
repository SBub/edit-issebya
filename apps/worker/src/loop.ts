export interface Drainer {
  // Starts draining, or asks the running drain for one more pass.
  signal(): void;
  // Resolves when no drain is running.
  idle(): Promise<void>;
}

// One job at a time: claim and run until claim returns null. Realtime and poll
// signals that arrive while busy coalesce into one more pass.
export function createDrainer<T>({
  claim,
  run,
  onError = (error) => console.error("worker: drain failed:", error),
}: {
  claim: () => Promise<T | null>;
  run: (job: T) => Promise<unknown>;
  onError?: (error: unknown) => void;
}): Drainer {
  let running: Promise<void> | null = null;
  let again = false;

  async function drain() {
    do {
      again = false;
      for (let job = await claim(); job !== null; job = await claim()) await run(job);
    } while (again);
  }

  return {
    signal() {
      if (running) {
        again = true;
        return;
      }
      running = drain()
        .catch(onError)
        .finally(() => {
          running = null;
        });
    },
    async idle() {
      while (running) await running;
    },
  };
}
