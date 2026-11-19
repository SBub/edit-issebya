export interface Drainer {
  // Starts draining, or asks the running drain for one more pass.
  signal(): void;
  // Resolves when no drain is running.
  idle(): Promise<void>;
}

// One job at a time: claim and run until claim returns null. Realtime and poll
// signals that arrive while busy coalesce into one more pass. The worker runs
// one of these per lane (createLanes).
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

export interface Lane<T> {
  // For logs and tests: `export`, `main`.
  name: string;
  // The oldest job this lane may take, now leased; null when none.
  claim: () => Promise<T | null>;
}

// The worker's lanes, side by side: each lane runs one job at a time (its own
// drainer), and the lanes run at the same time, so a job of one lane never
// waits behind a job of another. `between` (the deletion pass and the
// slimming) runs before a claim only while no lane is claiming or running a
// job, and no lane claims while it runs: storage is never slimmed under a
// running job. A signal wakes every lane.
export function createLanes<T>({
  lanes,
  run,
  between = async () => {},
  onError,
}: {
  lanes: readonly Lane<T>[];
  run: (job: T, lane: string) => Promise<unknown>;
  between?: () => Promise<void>;
  onError?: (error: unknown) => void;
}): Drainer {
  // Lanes that are claiming or running a job.
  let busy = 0;
  // The `between` pass in progress, if any.
  let pass: Promise<void> | null = null;

  // Waits out a pass in progress, runs one when every lane is quiet (at most
  // once per claim), then counts the caller as busy in the same tick as its
  // last check, so no pass can start between the check and the claim.
  async function enter() {
    let passed = false;
    for (;;) {
      if (pass) {
        await pass.catch(() => {});
        continue;
      }
      if (busy === 0 && !passed) {
        passed = true;
        pass = between().finally(() => {
          pass = null;
        });
        await pass;
        continue;
      }
      busy += 1;
      return;
    }
  }

  const drainers = lanes.map((lane) =>
    createDrainer<T>({
      claim: async () => {
        await enter();
        try {
          const job = await lane.claim();
          if (job === null) busy -= 1;
          return job;
        } catch (error) {
          busy -= 1;
          throw error;
        }
      },
      run: async (job) => {
        try {
          await run(job, lane.name);
        } finally {
          busy -= 1;
        }
      },
      onError,
    }),
  );

  return {
    signal() {
      for (const drainer of drainers) drainer.signal();
    },
    async idle() {
      await Promise.all(drainers.map((drainer) => drainer.idle()));
    },
  };
}
