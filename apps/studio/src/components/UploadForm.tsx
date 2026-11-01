"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { capture } from "@/lib/track";
import { parseUploadRequest } from "@/lib/upload";
import {
  RESUME_KEY,
  type ResumeRecord,
  clearResume,
  matchesResume,
  parseResume,
  readResume,
  writeResume,
} from "@/lib/upload-resume";
import { type Uploader, createUploader } from "@/lib/uploader";

type UploadState = "idle" | "uploading" | "failed" | "restart" | "cancelled" | "invalid";

const MESSAGES: Record<Exclude<UploadState, "uploading">, string> = {
  idle: "",
  failed: "Upload failed. Pick the same file to continue where it stopped.",
  restart: "Upload failed. Pick the file again to start over.",
  cancelled: "Upload cancelled.",
  invalid: "Pick an MP4, MOV, M4V or WebM clip up to 5 GB.",
};

// The resume record as an external store: read from localStorage on the
// client (null on the server), re-read when this tab writes it or another tab
// changes it. The raw string is the snapshot, so it is stable between reads.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === RESUME_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

function rawResume(): string | null {
  try {
    return window.localStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}

function useResumeRecord(): ResumeRecord | null {
  const raw = useSyncExternalStore(subscribe, rawResume, () => null);
  return useMemo(() => (raw === null ? null : parseResume(raw)), [raw]);
}

// The browser PUTs each 10 MiB part straight to its own signed storage URL;
// the studio's server only creates, signs, lists, completes and aborts. An
// interrupted upload continues from the parts storage already holds once the
// same file is picked again.
export function UploadForm() {
  const router = useRouter();
  const [state, setState] = useState<UploadState>("idle");
  const [percent, setPercent] = useState(0);
  const uploader = useRef<Uploader | null>(null);
  // The file being uploaded, for the resume record.
  const pending = useRef<File | null>(null);
  const resume = useResumeRecord();
  const busy = state === "uploading";

  // Uppy is an external system: closed when the form goes away.
  useEffect(
    () => () => {
      uploader.current?.close();
      uploader.current = null;
    },
    [],
  );

  function uploaderOf(): Uploader {
    uploader.current ??= createUploader({
      onProgress: setPercent,
      onCreated: ({ reelId, key, uploadId }) => {
        const file = pending.current;
        if (!file) return;
        writeResume(window.localStorage, {
          reelId,
          key,
          uploadId,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
        });
        notify();
      },
    });
    return uploader.current;
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("clip");
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (!file || !parseUploadRequest({ name: file.name, bytes: file.size, type: file.type }).ok) {
      setState("invalid");
      return;
    }
    const resumed = resume && matchesResume(resume, file) ? resume : null;
    pending.current = file;
    setPercent(0);
    setState("uploading");
    const outcome = await uploaderOf().start(
      file,
      resumed ? { key: resumed.key, uploadId: resumed.uploadId } : undefined,
    );
    pending.current = null;
    if (outcome.status === "finished") {
      clearResume(window.localStorage);
      notify();
      capture("studio_footage_uploaded", { reel_id: outcome.reelId });
      router.push(`/reels/${outcome.reelId}`);
      return;
    }
    if (outcome.status === "cancelled") {
      clearResume(window.localStorage);
      notify();
      setState("cancelled");
      return;
    }
    if (resumed) {
      // The interrupted upload can no longer continue (finished elsewhere,
      // cancelled, or gone): the next attempt starts fresh.
      clearResume(window.localStorage);
      notify();
    }
    // With a record left, picking the same file continues where it stopped.
    setState(readResume(window.localStorage) ? "failed" : "restart");
    // A signed-out answer: the page shows the login form again.
    router.refresh();
  }

  function cancel() {
    uploader.current?.cancel();
  }

  const status = busy ? `Uploading... ${percent}%` : MESSAGES[state];

  return (
    <form onSubmit={upload} className="flex flex-col gap-3" noValidate>
      {resume && !busy ? (
        <p data-testid="upload-resume" className="text-sm">
          An upload of {resume.name} was interrupted. Pick the same file to resume.
        </p>
      ) : null}
      <label htmlFor="clip" className="text-sm font-medium">
        Clip
      </label>
      <input
        id="clip"
        name="clip"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm"
        aria-describedby="upload-status"
        disabled={busy}
        className="w-full max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-base"
      />
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-md bg-stone-900 px-4 py-2 text-base font-medium text-white disabled:opacity-60"
        >
          Upload
        </button>
        {busy ? (
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-stone-300 px-4 py-2 text-base font-medium"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {busy ? (
        <progress
          aria-label="Upload progress"
          data-testid="upload-progress"
          max={100}
          value={percent}
          className="h-2 w-full overflow-hidden rounded-full accent-stone-900"
        />
      ) : null}
      <p id="upload-status" aria-live="polite" className="min-h-6 text-sm">
        {status}
      </p>
    </form>
  );
}
