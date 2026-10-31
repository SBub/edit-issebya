export interface LeaseKeeper {
  // Aborted when the lease is lost (a renewal returned false or threw).
  signal: AbortSignal;
  stop(): void;
}

// Renews the job's lease every `everyMs` while the job runs. A lost lease
// aborts the signal, so the running step stops writing.
export function keepLease({
  renew,
  everyMs,
}: {
  renew: () => Promise<boolean>;
  everyMs: number;
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

  function lose(reason: Error) {
    clearInterval(timer);
    if (!controller.signal.aborted) controller.abort(reason);
  }

  return {
    signal: controller.signal,
    stop() {
      clearInterval(timer);
    },
  };
}
