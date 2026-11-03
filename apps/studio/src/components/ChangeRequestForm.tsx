"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type Ref, useImperativeHandle, useRef, useState } from "react";
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
  // The overlay's "Change the request" puts a refused request back here.
  ref?: Ref<ChangeRequestHandle>;
}

export interface ChangeRequestHandle {
  // Sets the text, clears the message, focuses the field, caret at the end.
  refill(text: string): void;
}

// The text box: pinned at the bottom on a phone; on desktop it fills the
// bottom 32% of the right side, the field growing to the space. Sending
// queues a `change` job with the owner's words; it runs after the reel's earlier jobs (the database's order),
// and the new version reaches the preview through Realtime.
export function ChangeRequestForm({ reelId, blockedReason, queueNote, jobs, ref }: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<{ jobId: string; request: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      refill(value: string) {
        setText(value);
        setMessage("");
        const element = field.current;
        if (!element) return;
        // The value is set on the element now, so the caret lands after it
        // before React's render catches up with the same text.
        element.value = value;
        element.focus();
        element.setSelectionRange(value.length, value.length);
      },
    }),
    [],
  );

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
    <form onSubmit={send} className="flex flex-col gap-1 lg:min-h-0 lg:flex-1" noValidate>
      {/* One box, like a chat composer: the field and, at its bottom right,
          the Send button. The textarea's right padding keeps text from
          running under the button. The global focus outline is off on the
          textarea only; the whole box shows the ring instead. */}
      <div
        data-testid="change-field"
        className="relative flex rounded-reel border border-line bg-chrome focus-within:ring-2 focus-within:ring-accent has-[textarea:disabled]:bg-chrome/50 lg:min-h-0 lg:flex-1"
      >
        <textarea
          ref={field}
          id="change-request"
          name="request"
          rows={2}
          maxLength={MAX_REQUEST_LENGTH}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          aria-label="Ask for a change"
          aria-describedby="change-reason change-status"
          placeholder="What should change? For example: slower transitions, no photos in this one, bigger captions"
          className="min-w-0 flex-1 resize-none bg-transparent py-2 pr-12 pl-3 text-base outline-none! placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={disabled}
          aria-label="Send"
          title="Send"
          className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-reel bg-accent text-surface disabled:opacity-50"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
      <p
        id="change-reason"
        data-testid="change-blocked-reason"
        className="flex-none text-xs text-muted"
      >
        {blockedReason ??
          (queueNote ? <span data-testid="change-queue-note">{queueNote}</span> : "")}
      </p>
      <p id="change-status" aria-live="polite" className="flex-none text-xs break-words">
        {pending && sent ? (
          <span data-testid="change-pending">Pending: {sent.request}</span>
        ) : (
          message
        )}
      </p>
    </form>
  );
}
