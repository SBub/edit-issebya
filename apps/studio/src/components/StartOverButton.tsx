"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestStartOver } from "@/app/change-actions";
import type { JobRow } from "@/lib/jobs";

// A temporary testing control, to be removed (app_docs/change-requests.md):
// delete this file and its one use in LiveReel.

interface Props {
  reelId: string;
  // Null when changes are open; otherwise why not (the change box's rule).
  blockedReason: string | null;
  // The queue note (`Waiting: ...`) while any job of the reel is live.
  queueNote: string | null;
  // The reel's live jobs, so the button stays off until its own job ends.
  jobs: readonly Pick<JobRow, "id" | "status">[];
  hasVersion: boolean;
}

const LIVE: readonly JobRow["status"][] = ["queued", "running", "waiting_ai"];
const FAILED = "Start over did not start. Try again";

// Beside the Versions heading: queues a `start_over` job, which reruns the
// first edit from version 1 (no request) and saves it as a new version. Off
// while the reel is blocked, has no version yet, or any job of it is live;
// its progress shows in the overlay like a change's.
export function StartOverButton({ reelId, blockedReason, queueNote, jobs, hasVersion }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // The job sent, until it shows in the live jobs and ends.
  const [sentId, setSentId] = useState<string | null>(null);
  const sentJob = sentId ? jobs.find((job) => job.id === sentId) : undefined;
  const pending = sentId !== null && (!sentJob || LIVE.includes(sentJob.status));
  const disabled = busy || pending || !hasVersion || blockedReason !== null || queueNote !== null;

  async function startOver() {
    setBusy(true);
    setMessage("");
    try {
      const result = await requestStartOver({ reelId });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") {
        setSentId(result.jobId);
        return;
      }
      setMessage(result.status === "failed" ? FAILED : result.reason);
    } catch {
      setMessage(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        data-testid="start-over-status"
        aria-live="polite"
        className="min-w-0 truncate text-xs text-muted empty:hidden"
      >
        {message}
      </span>
      <button
        type="button"
        data-testid="start-over"
        onClick={() => void startOver()}
        disabled={disabled}
        title={
          blockedReason ??
          queueNote ??
          "Rerun the first edit from version 1 and save it as a new version"
        }
        className="shrink-0 border border-line px-3 py-1 text-xs hover:bg-raised disabled:opacity-50"
      >
        Start over
      </button>
    </div>
  );
}
