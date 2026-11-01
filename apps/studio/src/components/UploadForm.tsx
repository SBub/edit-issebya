"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { abortUpload, createUpload, finishUpload, signUploadRequest } from "@/app/upload-actions";
import { type RunningUpload, startUpload } from "@/lib/multipart-upload";
import { capture } from "@/lib/track";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";
import {
  RESUME_STORAGE_KEY,
  type UploadResume,
  clearResume,
  matchesFile,
  parseResume,
} from "@/lib/upload-resume";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; percent: number }
  | { kind: "retrying"; percent: number }
  | { kind: "too-large" }
  | { kind: "invalid" }
  | { kind: "failed" }
  | { kind: "unavailable" };

const MESSAGES: Record<UploadState["kind"], string> = {
  idle: "",
  uploading: "Uploading...",
  retrying: "Connection lost. Retrying...",
  "too-large": "Pick a clip up to 1 GB.",
  invalid: "Pick an MP4, MOV, M4V or WebM clip up to 1 GB.",
  failed: "Upload failed. Try again.",
  unavailable: "Uploads are not available right now.",
};

// The resume record, read as an external store: the storage event covers
// other tabs, `notifyResume` this one (a tab never hears its own writes).
const resumeListeners = new Set<() => void>();

function notifyResume() {
  for (const listener of resumeListeners) listener();
}

function subscribeResume(listener: () => void) {
  resumeListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    resumeListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function resumeText(): string | null {
  try {
    return window.localStorage.getItem(RESUME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function forgetResume() {
  try {
    clearResume(window.localStorage);
  } catch {
    // Storage blocked: there is nothing to forget.
  }
  notifyResume();
}

// The browser sends the file straight to storage in parts, each signed by the
// studio; the studio's server only sees the file's name, size and type.
export function UploadForm() {
  const router = useRouter();
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const record = parseResume(useSyncExternalStore(subscribeResume, resumeText, () => null));
  const running = useRef<{ upload: RunningUpload; reelId: string } | null>(null);
  const captured = useRef(new Set<string>());
  const busy = state.kind === "uploading" || state.kind === "retrying";

  // Leaving the page stops the transfer; the resume record stays.
  useEffect(() => () => running.current?.upload.cancel(), []);

  async function finish(reelId: string) {
    try {
      const finished = await finishUpload({ reelId });
      if (finished.status === "signed-out") {
        router.refresh();
        return;
      }
      if (finished.status !== "finished") {
        setState({ kind: "failed" });
        return;
      }
      running.current?.upload.cancel();
      running.current = null;
      forgetResume();
      if (!captured.current.has(finished.reelId)) {
        captured.current.add(finished.reelId);
        capture("studio_footage_uploaded", { reel_id: finished.reelId });
      }
      router.push(`/reels/${finished.reelId}`);
    } catch {
      setState({ kind: "failed" });
    }
  }

  function begin(file: File, target: { reelId: string; key: string }, resumeUploadId?: string) {
    setState({ kind: "uploading", percent: 0 });
    const upload = startUpload({
      file,
      target,
      resumeUploadId,
      sign: signUploadRequest,
      store: {
        getItem: (name) => window.localStorage.getItem(name),
        setItem: (name, value) => {
          window.localStorage.setItem(name, value);
          notifyResume();
        },
        removeItem: (name) => {
          window.localStorage.removeItem(name);
          notifyResume();
        },
      },
      onProgress: (percent) => setState({ kind: "uploading", percent }),
      onRetrying: () =>
        setState((current) => ({
          kind: "retrying",
          percent: "percent" in current ? current.percent : 0,
        })),
      onFailed: () => setState({ kind: "failed" }),
      onSignedOut: () => router.refresh(),
      onDone: () => void finish(target.reelId),
    });
    running.current = { upload, reelId: target.reelId };
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("clip");
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    if (!file) {
      setState({ kind: "invalid" });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setState({ kind: "too-large" });
      return;
    }

    if (record && matchesFile(record, file)) {
      begin(file, { reelId: record.reelId, key: record.key }, record.uploadId);
      return;
    }
    if (record) discard(record);

    setState({ kind: "uploading", percent: 0 });
    try {
      const created = await createUpload({ name: file.name, bytes: file.size, type: file.type });
      if (created.status === "signed-out") {
        router.refresh();
        return;
      }
      if (created.status === "invalid") {
        setState({ kind: created.reason === "too-large" ? "too-large" : "invalid" });
        return;
      }
      if (created.status !== "ready") {
        setState({ kind: created.status });
        return;
      }
      begin(file, { reelId: created.reelId, key: created.key });
    } catch {
      setState({ kind: "failed" });
    }
  }

  // A stale upload: aborted in storage and marked failed in the background.
  function discard(stale: UploadResume) {
    forgetResume();
    void abortUpload({ reelId: stale.reelId, uploadId: stale.uploadId })
      .then(() => router.refresh())
      .catch(() => undefined);
  }

  async function cancel() {
    const current = running.current;
    running.current = null;
    if (!current) return;
    const uploadId = current.upload.uploadId();
    current.upload.cancel();
    forgetResume();
    setState({ kind: "idle" });
    try {
      await abortUpload({ reelId: current.reelId, uploadId });
    } catch {
      // The reel stays uploading; the list shows it as such.
    }
    router.refresh();
  }

  const percent = "percent" in state ? state.percent : 0;

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
        disabled={busy}
        className="w-full max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-base"
      />
      {record && !busy ? (
        <div
          data-testid="upload-stopped"
          className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="break-words">
            The upload of {record.name} stopped. Pick the same file to continue.
          </p>
          <button
            type="button"
            onClick={() => discard(record)}
            className="self-start rounded-md border border-stone-300 bg-white px-3 py-1 font-medium sm:self-auto"
          >
            Discard
          </button>
        </div>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-stone-900 px-4 py-2 text-base font-medium text-white disabled:opacity-60"
      >
        Upload
      </button>
      {busy ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              data-testid="upload-progress"
              className="h-3 w-full overflow-hidden rounded-full bg-stone-200"
            >
              <div
                className="h-full rounded-full bg-stone-900 transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right text-sm tabular-nums">{percent}%</span>
          </div>
          <button
            type="button"
            onClick={() => void cancel()}
            className="self-start rounded-md border border-stone-300 bg-white px-4 py-2 text-base font-medium"
          >
            Cancel
          </button>
        </div>
      ) : null}
      <p id="upload-status" aria-live="polite" className="min-h-6 text-sm">
        {MESSAGES[state.kind]}
      </p>
    </form>
  );
}
