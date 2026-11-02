"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { requestChange } from "@/app/change-actions";
import { MAX_REQUEST_LENGTH, normalizeRequest } from "@/lib/change-requests";
import type { JobRow } from "@/lib/jobs";
import { capture } from "@/lib/track";

interface Props {
  reelId: string;
  // Null when a change may be sent; otherwise why not, in one line.
  blockedReason: string | null;
  // What a change sent now waits for (processing, earlier jobs); null when
  // nothing is ahead. Shown only when not blocked.
  queueNote: string | null;
  // The reel's live jobs, so the pending line ends when its job does.
  jobs: readonly Pick<JobRow, "id" | "status">[];
}

// The text box under the preview. Sending queues a `change` job with the
// owner's words; it runs after the reel's earlier jobs (the database's order),
// and the new version reaches the preview through Realtime.
export function ChangeRequestForm({ reelId, blockedReason, queueNote, jobs }: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<{ jobId: string; request: string } | null>(null);

  // Derived from the live jobs: pending until the sent job is done or failed
  // (or while it has not arrived yet, or waits for the AI). No timer.
  const sentJob = sent ? jobs.find((job) => job.id === sent.jobId) : undefined;
  const pending =
    sent !== null &&
    (!sentJob ||
      sentJob.status === "queued" ||
      sentJob.status === "running" ||
      sentJob.status === "waiting_ai");
  const disabled = busy || pending || blockedReason !== null;

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeRequest(text);
    if (!normalized.ok) {
      setMessage(normalized.reason);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await requestChange({ reelId, text: normalized.request });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") {
        setText("");
        setSent({ jobId: result.jobId, request: normalized.request });
        capture("studio_change_requested", { reel_id: reelId });
        return;
      }
      setMessage(
        result.status === "failed" ? "The change was not sent. Try again." : result.reason,
      );
    } catch {
      setMessage("The change was not sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="flex flex-col gap-1" noValidate>
      <label htmlFor="change-request" className="text-xs font-medium text-muted">
        Ask for a change
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id="change-request"
          name="request"
          rows={2}
          maxLength={MAX_REQUEST_LENGTH}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          aria-describedby="change-reason change-status"
          placeholder="move the title lower"
          className="min-w-0 flex-1 resize-none rounded-xl border border-line bg-raised px-3 py-2 text-base placeholder:text-muted disabled:bg-panel"
        />
        <button
          type="submit"
          disabled={disabled}
          className="rounded-full bg-accent px-5 py-2 text-base font-semibold text-surface disabled:opacity-50"
        >
          Send
        </button>
      </div>
      <p id="change-reason" data-testid="change-blocked-reason" className="text-xs text-muted">
        {blockedReason ??
          (queueNote ? <span data-testid="change-queue-note">{queueNote}</span> : "")}
      </p>
      <p id="change-status" aria-live="polite" className="text-xs break-words">
        {pending && sent ? (
          <span data-testid="change-pending">Pending: {sent.request}</span>
        ) : (
          message
        )}
      </p>
    </form>
  );
}
