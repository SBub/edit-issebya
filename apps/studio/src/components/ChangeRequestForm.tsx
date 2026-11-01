"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { requestChange } from "@/app/version-actions";
import { MAX_REQUEST_CHARS } from "@/lib/change-request";
import { capture } from "@/lib/track";

type FormState =
  | { state: "idle" }
  | { state: "sending" }
  // The number of jobs the page showed when the request was queued: "sent"
  // shows until the new job arrives through Realtime.
  | { state: "sent"; jobCount: number }
  | { state: "error"; message: string };

const REFUSED = "The change was not sent. Reload the page and try again.";

// The text box under the preview: the owner's change in plain words, queued
// as a change job. Disabled, with the reason, while the interim ordering rule
// blocks a change.
export function ChangeRequestForm({
  reelId,
  blockedReason,
  jobCount,
}: {
  reelId: string;
  blockedReason: string | null;
  jobCount: number;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({ state: "idle" });
  const disabled = blockedReason !== null || form.state === "sending";

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const box = event.currentTarget.elements.namedItem("request");
    if (!(box instanceof HTMLTextAreaElement)) return;
    setForm({ state: "sending" });
    try {
      const result = await requestChange({ reelId, text: box.value });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "invalid") {
        setForm({ state: "error", message: result.reason });
        return;
      }
      if (result.status === "refused") {
        setForm({ state: "error", message: REFUSED });
        return;
      }
      box.value = "";
      setForm({ state: "sent", jobCount });
      // The reel id only: the words never leave the studio's own database.
      capture("studio_change_requested", { reel_id: reelId });
    } catch {
      setForm({ state: "error", message: REFUSED });
    }
  }

  const message =
    blockedReason ??
    (form.state === "sent" && form.jobCount === jobCount
      ? "Sent: waiting for the worker"
      : form.state === "error"
        ? form.message
        : "");

  return (
    <form onSubmit={send} className="flex flex-col gap-2" noValidate>
      <label htmlFor="change-request" className="text-sm font-medium">
        Ask for a change
      </label>
      <textarea
        id="change-request"
        name="request"
        rows={3}
        maxLength={MAX_REQUEST_CHARS}
        disabled={disabled}
        aria-describedby="change-status"
        placeholder="move the title lower"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-base disabled:bg-stone-100"
      />
      <button
        type="submit"
        disabled={disabled}
        className="self-start rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Send change
      </button>
      <p
        id="change-status"
        role="status"
        data-testid={blockedReason ? "change-blocked" : "change-status"}
        className={`text-sm ${form.state === "error" && !blockedReason ? "text-red-700" : "text-stone-600"}`}
      >
        {message}
      </p>
    </form>
  );
}
