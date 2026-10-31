"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { createUpload, finishUpload } from "@/app/upload-actions";
import { capture } from "@/lib/track";

type UploadState = "idle" | "uploading" | "failed" | "unavailable" | "invalid";

const MESSAGES: Record<UploadState, string> = {
  idle: "",
  uploading: "Uploading...",
  failed: "Upload failed. Try again.",
  unavailable: "Uploads are not available right now.",
  invalid: "Pick an MP4, MOV, M4V or WebM clip up to 5 GB.",
};

// The browser PUTs the file straight to the signed URL; the studio's server
// only sees its name, size and type.
export function UploadForm() {
  const router = useRouter();
  const [state, setState] = useState<UploadState>("idle");
  const busy = state === "uploading";

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("clip");
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (!file) {
      setState("invalid");
      return;
    }
    setState("uploading");
    try {
      const created = await createUpload({ name: file.name, bytes: file.size, type: file.type });
      if (created.status === "signed-out") {
        router.refresh();
        return;
      }
      if (created.status !== "ready") {
        setState(created.status);
        return;
      }
      const put = await fetch(created.url, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": created.contentType },
      });
      if (!put.ok) {
        setState("failed");
        return;
      }
      const finished = await finishUpload({ reelId: created.reelId, bytes: file.size });
      if (finished.status !== "finished") {
        setState("failed");
        return;
      }
      capture("studio_footage_uploaded", { reel_id: finished.reelId });
      router.push(`/reels/${finished.reelId}`);
    } catch {
      setState("failed");
    }
  }

  return (
    <form onSubmit={upload} className="flex flex-col gap-3" noValidate>
      <label htmlFor="clip" className="text-sm font-medium">
        Clip
      </label>
      <input
        id="clip"
        name="clip"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm"
        aria-describedby="upload-status"
        className="w-full max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-base"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-stone-900 px-4 py-2 text-base font-medium text-white disabled:opacity-60"
      >
        Upload
      </button>
      <p id="upload-status" aria-live="polite" className="min-h-6 text-sm">
        {MESSAGES[state]}
      </p>
    </form>
  );
}
