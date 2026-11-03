"use client";

import { type RefObject, useState } from "react";
import { CloseButton } from "@/components/CloseButton";
import { type LibraryItem, formatDimensions } from "@/lib/photos";
import { formatBytes } from "@/lib/reels";

interface Props {
  dialogRef: RefObject<HTMLDialogElement | null>;
  // The open photo, kept live by the library (null once it is gone).
  photo: LibraryItem | null;
  // Resolves with an error line, or null once the photo is deleted.
  onDelete: (photoId: string) => Promise<string | null>;
}

// One photo, large, with what the worker found in it: the description and the
// tags. A photo not described yet shows its status and no image. The header
// holds the bin (Delete) and the cross (Close) at the top right; the bin asks
// once more, Cancel and Yes, delete in its place, before it removes the photo
// and its files.
export function PhotoDialog({ dialogRef, photo, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function close() {
    dialogRef.current?.close();
  }

  async function remove() {
    if (!photo) return;
    setBusy(true);
    setMessage("");
    const error = await onDelete(photo.id);
    setBusy(false);
    if (error) {
      setMessage(error);
      return;
    }
    close();
  }

  const dimensions = photo ? formatDimensions(photo.width, photo.height) : null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="photo-heading"
      onClose={() => {
        setConfirming(false);
        setMessage("");
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100%-2rem))] overflow-y-auto border border-line bg-surface p-5 text-ink backdrop:bg-black/60"
    >
      <div className="mb-4 flex items-center gap-1">
        <h2 id="photo-heading" className="min-w-0 flex-1 truncate text-lg font-semibold">
          {photo?.fileName ?? "Photo"}
        </h2>
        {photo &&
          (confirming ? (
            <div data-testid="photo-delete-confirm" className="flex flex-none items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="border border-line px-3 py-1 text-sm hover:bg-raised"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                className="bg-danger px-3 py-1 text-sm font-medium text-surface disabled:opacity-60"
              >
                Yes, delete
              </button>
            </div>
          ) : (
            <button
              type="button"
              aria-label="Delete photo"
              title="Delete photo"
              onClick={() => setConfirming(true)}
              className="flex size-10 flex-none items-center justify-center text-danger transition-opacity hover:opacity-70"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 7h16" />
                <path d="M10 11v6M14 11v6" />
                <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                <path d="M9 7V4h6v3" />
              </svg>
            </button>
          ))}
        <CloseButton onClick={close} />
      </div>
      {photo && (
        <div className="flex flex-col gap-3">
          {photo.largeUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL, never a Next image
            <img
              src={photo.largeUrl}
              alt={photo.description ?? ""}
              className="max-h-[60dvh] w-full bg-raised object-contain"
            />
          ) : (
            <p
              data-testid="photo-dialog-status"
              className="border border-line bg-raised px-3 py-6 text-center text-sm text-muted"
            >
              {photo.status}
            </p>
          )}
          <p className="text-xs text-muted">
            {formatBytes(photo.bytes)}
            {dimensions ? ` · ${dimensions}` : ""}
          </p>
          {photo.description && (
            <p data-testid="photo-description" className="text-sm">
              {photo.description}
            </p>
          )}
          {photo.tags.length > 0 && (
            <ul aria-label="Tags" className="flex flex-wrap gap-1">
              {photo.tags.map((tag) => (
                <li
                  key={tag}
                  data-testid="photo-tag"
                  className="border border-line px-2 py-0.5 text-xs"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
          {message && (
            <p role="alert" className="text-sm text-danger">
              {message}
            </p>
          )}
        </div>
      )}
    </dialog>
  );
}
