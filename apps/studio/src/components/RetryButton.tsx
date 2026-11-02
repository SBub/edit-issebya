"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestRetry } from "@/app/retry-actions";

interface Props {
  reelId: string;
  jobId: string;
}

// Retry on a failed job's line: queues a new job of the same kind and
// parameters; the new job's line arrives through Realtime. Disabled while
// sending and once queued.
export function RetryButton({ reelId, jobId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [message, setMessage] = useState("");

  async function retry() {
    setBusy(true);
    setMessage("");
    try {
      const result = await requestRetry({ reelId, jobId });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") {
        setQueued(true);
        return;
      }
      if (result.status === "already") {
        setQueued(true);
        setMessage("This job is already being retried.");
        return;
      }
      setMessage(result.status === "failed" ? "Retry did not start. Try again." : result.reason);
    } catch {
      setMessage("Retry did not start. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        data-testid="job-retry"
        onClick={() => void retry()}
        disabled={busy || queued}
        className="rounded-md bg-stone-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
      >
        Retry
      </button>
      <span aria-live="polite" data-testid="job-retry-message" className="text-sm text-stone-700">
        {message}
      </span>
    </span>
  );
}
