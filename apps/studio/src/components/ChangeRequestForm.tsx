"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { requestChange } from "@/app/change-actions";
import { MAX_REQUEST_LENGTH, normalizeRequest } from "@/lib/change-requests";
import { type JobRow, isUnfinished } from "@/lib/jobs";
import { capture } from "@/lib/track";

interface Props {
  reelId: string;
  // Null when a change may be sent; otherwise why not, in one line.
  blockedReason: string | null;
  // When it may be sent: what happens to it (it waits its turn), or null.
  notice: string | null;
  // The reel's live jobs, so the pending line ends when its job does.
  jobs: readonly Pick<JobRow, "id" | "status">[];
}

// The text box under the preview. Sending queues a `change` job with the
// owner's words; the new version reaches the preview through Realtime.
export function ChangeRequestForm({ reelId, blockedReason, notice, jobs }: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<{ jobId: string; request: string } | null>(null);

  // Derived from the live jobs: pending until the sent job is done or failed
  // (or while it has not arrived yet, or waits for the AI). No timer.
  const sentJob = sent ? jobs.find((job) => job.id === sent.jobId) : undefined;
  const pending = sent !== null && (!sentJob || isUnfinished(sentJob));
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
    <form onSubmit={send} className="flex flex-col gap-2" noValidate>
      <label htmlFor="change-request" className="text-sm font-medium">
        Ask for a change
      </label>
      <textarea
        id="change-request"
        name="request"
        rows={3}
        maxLength={MAX_REQUEST_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={disabled}
        aria-describedby="change-reason change-notice change-status"
        placeholder="move the title lower"
        className="w-full max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-base disabled:bg-stone-100"
      />
      <p id="change-reason" data-testid="change-blocked-reason" className="text-sm text-stone-600">
        {blockedReason ?? ""}
      </p>
      {blockedReason === null && notice && (
        <p id="change-notice" data-testid="change-notice" className="text-sm text-stone-600">
          {notice}
        </p>
      )}
      <button
        type="submit"
        disabled={disabled}
        className="self-start rounded-md bg-stone-900 px-4 py-2 text-base font-medium text-white disabled:opacity-60"
      >
        Send
      </button>
      <p id="change-status" aria-live="polite" className="min-h-6 text-sm break-words">
        {pending && sent ? (
          <span data-testid="change-pending">Pending: {sent.request}</span>
        ) : (
          message
        )}
      </p>
    </form>
  );
}
