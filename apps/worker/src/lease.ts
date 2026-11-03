export interface LeaseKeeper {
  // Aborted when the lease is lost (a renewal returned false or threw), the
  // job was cancelled (the reason is then a JobCancelled) or its row is gone
  // (its reel or photo was deleted; the reason is then a JobGone).
  signal: AbortSignal;
  // Checks for a cancel now (beside the timer): true, and the signal aborted,
  // when the job was cancelled. Without a `cancelled` check it is always false.
  checkCancelled(): Promise<boolean>;
  // Checks now whether the job's row is gone: true, and the signal aborted
  // with a JobGone, when it is. Without a `gone` check it is always false.
  checkGone(): Promise<boolean>;
  stop(): void;
}

// The owner cancelled the job (`cancel_job`): the worker stops and writes
// nothing more, as on a lost lease.
class JobCancelled extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelled";
  }
}

export function isJobCancelled(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof JobCancelled;
}

// The job's row is gone: its owner deleted the reel (or the photo), and the
// cascade took the job with it. The worker stops and writes nothing more; it
// is not a failure.
class JobGone extends Error {
  constructor() {
    super("job deleted");
    this.name = "JobGone";
  }
}

export function isJobGone(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof JobGone;
}

// Renews the job's lease every `everyMs` while the job runs. A lost lease
// aborts the signal, so the running step stops writing. Given `cancelled`
// (a render job), one cheap check every `cancelCheckEveryMs` reads whether the
// owner cancelled the job, and a cancel aborts the signal the same way, so
// the running tool's process group is killed within seconds. Given `gone`, a
// renewal that matched no row asks whether the job's row still exists: gone,
// the signal aborts with a JobGone instead of a lost lease, within one renewal.
export function keepLease({
  renew,
  everyMs,
  cancelled,
  cancelCheckEveryMs = 5000,
  gone,
}: {
  renew: () => Promise<boolean>;
  everyMs: number;
  cancelled?: () => Promise<boolean>;
  cancelCheckEveryMs?: number;
  gone?: () => Promise<boolean>;
}): LeaseKeeper {
  const controller = new AbortController();
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    renew()
      .then(async (held) => {
        if (held) return;
        // A failed check is not gone: the lease is lost as before.
        const deleted = gone ? await gone().catch(() => false) : false;
        lose(deleted ? new JobGone() : new Error("lease lost"));
      })
      .catch((error: unknown) => lose(new Error("lease lost", { cause: error })))
      .finally(() => {
        renewing = false;
      });
  }, everyMs);

  let checking = false;
  async function checkCancelled(): Promise<boolean> {
    if (isJobCancelled(controller.signal)) return true;
    if (!cancelled || controller.signal.aborted) return false;
    // A failed check is not a cancel: the renewal decides about the lease.
    const yes = await cancelled().catch(() => false);
    if (yes) lose(new JobCancelled());
    return isJobCancelled(controller.signal);
  }
  async function checkGone(): Promise<boolean> {
    if (isJobGone(controller.signal)) return true;
    if (!gone || controller.signal.aborted) return false;
    // A failed check is not gone.
    const yes = await gone().catch(() => false);
    if (yes) lose(new JobGone());
    return isJobGone(controller.signal);
  }
  const cancelTimer = cancelled
    ? setInterval(() => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        void checkCancelled().finally(() => {
          checking = false;
        });
      }, cancelCheckEveryMs)
    : undefined;

  function lose(reason: Error) {
    clearInterval(timer);
    clearInterval(cancelTimer);
    if (!controller.signal.aborted) controller.abort(reason);
  }

  return {
    signal: controller.signal,
    checkCancelled,
    checkGone,
    stop() {
      clearInterval(timer);
      clearInterval(cancelTimer);
    },
  };
}
