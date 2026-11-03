"use client";

import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFileDrop } from "@/components/FileDrop";
import { TOO_MANY_FILES, decideDrop } from "@/lib/file-drop";
import { formatBytes } from "@/lib/reels";
import { capture, captureException } from "@/lib/track";
import { CLIP_ACCEPT, CLIP_LIMITS, parseUploadRequest } from "@/lib/upload";
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

type UploadState =
  "idle" | "uploading" | "failed" | "restart" | "cancelled" | "invalid" | "too-many";

const MESSAGES: Record<Exclude<UploadState, "uploading">, string> = {
  idle: "",
  failed: "Upload failed. Pick the same file to continue where it stopped.",
  restart: "Upload failed. Pick the file again to start over.",
  cancelled: "Upload cancelled.",
  invalid: "Pick an MP4, MOV, M4V or WebM clip up to 5 GB.",
  "too-many": TOO_MANY_FILES,
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
// same file is picked again. The clip is chosen in a dashed drop zone: a click
// (or Enter or Space on the visually hidden input inside it) opens the picker,
// a drop of one clip chooses it, and the zone then shows its name and size.
export function UploadForm() {
  const router = useRouter();
  const [state, setState] = useState<UploadState>("idle");
  const [percent, setPercent] = useState(0);
  const uploader = useRef<Uploader | null>(null);
  // The file being uploaded, for the resume record.
  const pending = useRef<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // The chosen clip, from the picker or a drop.
  const [chosen, setChosen] = useState<File | null>(null);
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

  function choose(file: File) {
    setChosen(file);
    if (state === "invalid" || state === "too-many") setState("idle");
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    // A cancelled picker keeps the clip chosen before.
    const file = event.target.files?.[0];
    if (file) choose(file);
  }

  // A drop of one clip the picker would offer chooses it, as a pick does;
  // anything else chooses nothing and says why. Ignored while uploading.
  const drop = useFileDrop((files) => {
    if (busy) return;
    const decision = decideDrop(files, CLIP_ACCEPT);
    if (decision.kind === "upload") {
      // The hidden input no longer holds a different clip than the zone shows.
      if (input.current) input.current.value = "";
      choose(decision.file);
    } else if (decision.kind === "too-many") setState("too-many");
    else if (decision.kind === "refused") setState("invalid");
  });

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = chosen;
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
    // One exception per failed upload, never on cancel: the routes' answer,
    // never the file's name, size, key or upload id.
    captureException("studio: upload failed", {
      status: outcome.answer?.status ?? null,
      error_code: outcome.answer?.error ?? null,
      resumed: Boolean(resumed),
    });
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
      <label
        htmlFor="clip"
        data-testid="upload-drop"
        data-drop={drop.over ? "over" : "idle"}
        {...(busy ? {} : drop.handlers)}
        className={`flex min-h-44 flex-col items-center justify-center gap-2 border-2 border-dashed bg-surface px-4 py-8 text-center transition-colors has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent ${
          drop.over
            ? "border-accent bg-raised text-accent"
            : busy
              ? "border-line opacity-60"
              : "cursor-pointer border-line hover:border-muted"
        }`}
      >
        <input
          ref={input}
          id="clip"
          name="clip"
          type="file"
          accept={CLIP_ACCEPT}
          aria-label="Clip"
          aria-describedby="upload-status"
          disabled={busy}
          onChange={onPick}
          className="sr-only"
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-8 text-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 16V4M7 9l5-5 5 5" />
          <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
        </svg>
        {chosen ? (
          <>
            <span data-testid="upload-chosen" className="max-w-full truncate text-base font-medium">
              {chosen.name}
            </span>
            <span className="text-sm text-muted">
              {formatBytes(chosen.size)}
              {busy ? null : (
                <>
                  {" · "}
                  <span className="text-accent underline underline-offset-2">Choose another</span>
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <span data-testid="upload-prompt" className="text-base font-medium">
              {drop.over ? (
                "Drop to choose this video"
              ) : (
                <>
                  <span className="pointer-coarse:hidden">
                    Drop a video here or click to choose
                  </span>
                  <span className="hidden pointer-coarse:inline">Tap to choose a video</span>
                </>
              )}
            </span>
            <span className="text-sm text-muted">{CLIP_LIMITS}</span>
          </>
        )}
      </label>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 bg-primary px-4 py-2 text-base font-medium text-on-primary enabled:hover:opacity-90 disabled:opacity-50"
        >
          Upload
        </button>
        {busy ? (
          <button
            type="button"
            onClick={cancel}
            className="border border-line px-4 py-2 text-base font-medium"
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
          className="h-2 w-full appearance-none overflow-hidden bg-raised [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-raised [&::-webkit-progress-value]:bg-accent"
        />
      ) : null}
      <p id="upload-status" aria-live="polite" className="min-h-6 text-sm">
        {status}
      </p>
    </form>
  );
}
