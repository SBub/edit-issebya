export interface LeaseKeeper {
  // Aborted when the lease is lost (a renewal returned false or threw) or the
  // job was cancelled (the reason is then a JobCancelled).
  signal: AbortSignal;
  // Checks for a cancel now (beside the timer): true, and the signal aborted,
  // when the job was cancelled. Without a `cancelled` check it is always false.
  checkCancelled(): Promise<boolean>;
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

// Renews the job's lease every `everyMs` while the job runs. A lost lease
// aborts the signal, so the running step stops writing. Given `cancelled`
// (a render job), one cheap check every `cancelCheckEveryMs` reads whether the
// owner cancelled the job, and a cancel aborts the signal the same way, so
// the running tool's process group is killed within seconds.
export function keepLease({
  renew,
  everyMs,
  cancelled,
  cancelCheckEveryMs = 5000,
}: {
  renew: () => Promise<boolean>;
  everyMs: number;
  cancelled?: () => Promise<boolean>;
  cancelCheckEveryMs?: number;
}): LeaseKeeper {
  const controller = new AbortController();
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    renew()
      .then((held) => {
        if (!held) lose(new Error("lease lost"));
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
    stop() {
      clearInterval(timer);
      clearInterval(cancelTimer);
    },
  };
}
