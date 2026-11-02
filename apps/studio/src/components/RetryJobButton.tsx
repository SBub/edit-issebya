"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { retryJob } from "@/app/retry-actions";

interface Props {
  reelId: string;
  jobId: string;
}

// Retry on a failed job: queues one new job of the same kind and parameters;
// the new job and this one's `retried` label arrive through Realtime.
export function RetryJobButton({ reelId, jobId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function retry() {
    setBusy(true);
    setMessage("");
    try {
      const result = await retryJob({ reelId, jobId });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") return;
      setMessage(
        result.status === "blocked" ? result.reason : "The retry was not sent. Try again.",
      );
    } catch {
      setMessage("The retry was not sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        data-testid="job-retry"
        onClick={retry}
        disabled={busy}
        className="rounded-md bg-stone-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
      >
        Retry
      </button>
      {message && (
        <span data-testid="job-retry-message" className="text-sm text-red-700">
          {message}
        </span>
      )}
    </span>
  );
}
